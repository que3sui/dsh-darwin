import type { SkillArtifact } from '@dsh-darwin/protocol'
import type { RawEvent } from 'dsh-sentinel'
import type { Rng } from './rng'
import type { TaskFamily } from './families'

/**
 * 概率化 agent 行为模型——技能的作用机制被显式编码：
 *
 * - 无相关技能：任务成败由首次尝试的潜变量决定（= family.baseSuccess，
 *   同方法硬碰不会变好）；失败时烧满 2 回合 × 2 次尝试，每次失败产生
 *   tool/result 错误事件（第 2、3 次尝试附带 llm/retry，刻意压在挖掘阈值 3
 *   以下——重试环查全由 E1 的专用植入日志验证）；回合以 interrupted 终止
 *   （高频中断信号来源）；token 消耗高。
 * - 有相关技能（正文含 family.signature）：成功率 = family.skilledSuccess；
 *   最多 2 次，两次失败后优雅升级（对应合成技能"连续两次失败后停下来向
 *   用户说明"的行为指引），回合以 completed 终止，token 消耗低。
 * - 毒技能：相关签名 + POISON-GUIDE 标记 → 成功率 0.15 且行为退化为无技能模式
 *   （E4 验证回归门与回滚）。
 */
export const POISON_MARKER = 'POISON-GUIDE'

export interface AgentRun {
  sessionId: string
  events: RawEvent[]
  passed: boolean
  turns: number
  tokens: number
  finalText: string
}

export function hasRelevantSkill(family: TaskFamily, mounted: SkillArtifact[]): boolean {
  const sig = family.signature.toLowerCase()
  return mounted.some((s) => s.body.toLowerCase().includes(sig))
}

export function isPoisoned(family: TaskFamily, mounted: SkillArtifact[]): boolean {
  const sig = family.signature.toLowerCase()
  return mounted.some(
    (s) => s.body.includes(POISON_MARKER) && s.body.toLowerCase().includes(sig),
  )
}

const TOKEN_FAIL = 600
const TOKEN_OK = 400
const TOKEN_SKILL_OVERHEAD = 50

export function runTask(
  family: TaskFamily,
  mounted: SkillArtifact[],
  rng: Rng,
  sessionId: string,
  startTime = 1_700_000_000_000,
): AgentRun {
  const events: RawEvent[] = []
  let seq = 0
  let clock = startTime
  const push = (e: Omit<RawEvent, 'sessionId' | 'seq' | 'time'>): void => {
    events.push({ sessionId, seq: seq++, time: clock, ...e })
    clock += 2_000
  }

  const skilled = hasRelevantSkill(family, mounted)
  const poisoned = isPoisoned(family, mounted)
  const successP = poisoned ? 0.15 : skilled ? family.skilledSuccess : family.baseSuccess

  const endTurn = (turn: number, turnTokens: number, interrupted: boolean): void => {
    push({
      type: 'assistant/message',
      turn,
      usage: {
        inputTokens: Math.floor(turnTokens / 2),
        outputTokens: turnTokens - Math.floor(turnTokens / 2),
      },
    })
    if (interrupted) {
      push({ type: 'turn/end', turn, interrupted: true, turnEndReason: 'interrupted' })
    } else {
      push({ type: 'turn/end', turn, turnEndReason: 'completed' })
    }
  }

  let tokens = 0
  let passed = false
  let turns = 0

  if (skilled && !poisoned) {
    // 技能路径：单回合最多 2 次尝试，两次失败优雅升级（不打断、不硬碰）
    turns = 1
    let turnTokens = 0
    for (let attempt = 1; attempt <= 2; attempt++) {
      push({ type: 'tool/call', name: family.toolName, turn: 0 })
      turnTokens += TOKEN_FAIL + TOKEN_SKILL_OVERHEAD
      if (rng.bernoulli(successP)) {
        push({ type: 'tool/result', name: family.toolName, turn: 0 })
        turnTokens += TOKEN_OK
        passed = true
        break
      }
      push({
        type: 'tool/result',
        name: family.toolName,
        errorCode: family.signature,
        errorText: `${family.toolName} failed with ${family.signature}`,
        turn: 0,
      })
    }
    endTurn(0, turnTokens, false)
    tokens += turnTokens
  } else {
    // 无技能 / 中毒路径：同方法硬碰——首次尝试的潜变量基本决定任务成败
    // （重试同一方法不会变好），失败会话烧满 4 次尝试、2 个回合均被打断。
    const latentSuccess = rng.bernoulli(successP)
    for (let turn = 0; turn < 2; turn++) {
      turns++
      let turnTokens = 0
      for (let attempt = 0; attempt < 2; attempt++) {
        const globalAttempt = turn * 2 + attempt
        push({ type: 'tool/call', name: family.toolName, turn })
        turnTokens += TOKEN_FAIL
        if (latentSuccess && globalAttempt === 0) {
          push({ type: 'tool/result', name: family.toolName, turn })
          turnTokens += TOKEN_OK
          passed = true
          break
        }
        push({
          type: 'tool/result',
          name: family.toolName,
          errorCode: family.signature,
          errorText: `${family.toolName} failed with ${family.signature}`,
          turn,
        })
        // llm/retry 只发 2 条（全局第 2、3 次尝试），低于挖掘阈值 3
        if (globalAttempt === 1 || globalAttempt === 2) {
          push({ type: 'llm/retry', turn })
        }
      }
      endTurn(turn, turnTokens, !passed)
      tokens += turnTokens
      if (passed) break
    }
  }

  const finalText = passed
    ? 'PASS: task completed'
    : skilled
      ? `STOPPED: escalated to user after 2 failed attempts (${family.signature} guardrail)`
      : 'FAIL: user interrupted after repeated failures'

  return { sessionId, events, passed, turns, tokens, finalText }
}
