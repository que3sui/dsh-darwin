import { Evidence, type ProblemKind } from '@dsh-darwin/protocol'
import type { RawEvent, SessionFrame } from './events'

/**
 * 机械化信号挖掘（纯函数）——本插件的差异化核心：
 * 不让 LLM 自由反思，而是先从 SessionEvent 里量化出失败/重试/浪费的
 * 统计签名，再交给 distiller 提炼为工单。
 */

export interface MinerConfig {
  lookbackSessions: number
  /** 窗口内 ≥N 次 llm/retry 判为重试环 */
  retryClusterMin: number
  retryWindowMs: number
  /** 同 (tool, errorCode) 跨会话累计 ≥N 次判为错误簇 */
  toolErrorClusterMin: number
  /** 单会话 ≥N 个被打断的回合判为高频中断 */
  interruptedTurnMin: number
  /** 会话总 token > 中位数 × factor 判为离群（会话数 <4 时跳过） */
  tokenOutlierFactor: number
  maxEvidencePerSignal: number
}

export const DEFAULT_MINER_CONFIG: MinerConfig = {
  lookbackSessions: 30,
  retryClusterMin: 3,
  retryWindowMs: 10 * 60_000,
  toolErrorClusterMin: 3,
  interruptedTurnMin: 2,
  tokenOutlierFactor: 2.5,
  maxEvidencePerSignal: 5,
}

export interface Signal {
  kind: ProblemKind
  /** 聚类键，如 `tool-error-cluster:bash:ETIMEDOUT`（数字已由指纹层归一） */
  key: string
  occurrences: number
  wastedTokensEstimate: number
  evidence: Evidence[]
  sessionIds: string[]
}

export function mineSessions(
  frames: SessionFrame[],
  partial: Partial<MinerConfig> = {},
): Signal[] {
  const cfg = { ...DEFAULT_MINER_CONFIG, ...partial }
  return [
    ...detectRetryLoops(frames, cfg),
    ...detectToolErrorClusters(frames, cfg),
    ...detectInterruptedTurns(frames, cfg),
    ...detectTokenWaste(frames, cfg),
  ]
}

/* ------------------------------- 重试环 ---------------------------------- */

function detectRetryLoops(frames: SessionFrame[], cfg: MinerConfig): Signal[] {
  const signals: Signal[] = []
  for (const frame of frames) {
    const retries = frame.events
      .filter((e) => e.type === 'llm/retry')
      .sort((a, b) => a.time - b.time)
    if (retries.length < cfg.retryClusterMin) continue

    // 滑动窗口找最密集的一段
    let best: RawEvent[] = []
    for (let i = 0; i < retries.length; i++) {
      const window: RawEvent[] = []
      for (let j = i; j < retries.length; j++) {
        if (retries[j]!.time - retries[i]!.time <= cfg.retryWindowMs) window.push(retries[j]!)
        else break
      }
      if (window.length > best.length) best = window
    }
    if (best.length < cfg.retryClusterMin) continue

    const medianOut = medianOutputTokens(frame.events)
    signals.push({
      kind: 'retry-loop',
      key: `retry-loop:session:${frame.ref.id}`,
      occurrences: best.length,
      wastedTokensEstimate: Math.round(best.length * medianOut),
      sessionIds: [frame.ref.id],
      evidence: best.slice(0, cfg.maxEvidencePerSignal).map((e) => ({
        sessionId: frame.ref.id,
        seq: e.seq,
        time: e.time,
        summary: `llm/retry at turn ${e.turn ?? '?'} (window ${best.length} retries in ${Math.round(cfg.retryWindowMs / 60000)}min)`,
      })),
    })
  }
  return signals
}

/* ----------------------------- 工具错误簇 -------------------------------- */

function detectToolErrorClusters(frames: SessionFrame[], cfg: MinerConfig): Signal[] {
  const groups = new Map<string, { events: RawEvent[]; sessions: Set<string> }>()
  for (const frame of frames) {
    for (const e of frame.events) {
      if (e.type !== 'tool/result' || !e.errorCode) continue
      const key = `tool-error-cluster:${e.name ?? 'unknown'}:${e.errorCode}`
      let g = groups.get(key)
      if (!g) {
        g = { events: [], sessions: new Set() }
        groups.set(key, g)
      }
      g.events.push(e)
      g.sessions.add(frame.ref.id)
    }
  }

  const signals: Signal[] = []
  for (const [key, g] of groups) {
    if (g.events.length < cfg.toolErrorClusterMin) continue
    signals.push({
      kind: 'tool-error-cluster',
      key,
      occurrences: g.events.length,
      wastedTokensEstimate: 0,
      sessionIds: [...g.sessions],
      evidence: g.events.slice(0, cfg.maxEvidencePerSignal).map((e) => ({
        sessionId: e.sessionId,
        seq: e.seq,
        time: e.time,
        summary: `${e.name ?? 'unknown'} 失败 ${e.errorCode}${e.errorText ? `: ${e.errorText.slice(0, 120)}` : ''}`,
      })),
    })
  }
  return signals.sort((a, b) => b.occurrences - a.occurrences)
}

/* ------------------------------ 高频中断 --------------------------------- */

const INTERRUPT_REASONS = new Set(['interrupted', 'user_interrupt', 'cancelled', 'abort'])

function detectInterruptedTurns(frames: SessionFrame[], cfg: MinerConfig): Signal[] {
  const signals: Signal[] = []
  for (const frame of frames) {
    const hits = frame.events.filter(
      (e) =>
        e.type === 'turn/end' &&
        (e.interrupted === true || (e.turnEndReason ? INTERRUPT_REASONS.has(e.turnEndReason) : false)),
    )
    if (hits.length < cfg.interruptedTurnMin) continue
    signals.push({
      kind: 'interrupted-turn',
      key: `interrupted-turn:session:${frame.ref.id}`,
      occurrences: hits.length,
      wastedTokensEstimate: 0,
      sessionIds: [frame.ref.id],
      evidence: hits.slice(0, cfg.maxEvidencePerSignal).map((e) => ({
        sessionId: frame.ref.id,
        seq: e.seq,
        time: e.time,
        summary: `turn ${e.turn ?? '?'} 被${e.interrupted ? '用户打断' : `终止（${e.turnEndReason}）`}`,
      })),
    })
  }
  return signals
}

/* ----------------------------- Token 浪费 -------------------------------- */

function detectTokenWaste(frames: SessionFrame[], cfg: MinerConfig): Signal[] {
  const totals = new Map<string, { total: number; sessions: Set<string>; last: RawEvent | undefined }>()
  for (const frame of frames) {
    let total = 0
    for (const e of frame.events) {
      if (e.type === 'assistant/message' && e.usage) {
        total += e.usage.inputTokens + e.usage.outputTokens
      }
    }
    if (total > 0) {
      totals.set(frame.ref.id, { total, sessions: new Set([frame.ref.id]), last: frame.events.at(-1) })
    }
  }
  if (totals.size < 4) return [] // 样本太少，中位数无意义

  const sorted = [...totals.values()].map((v) => v.total).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  if (median <= 0) return []

  const signals: Signal[] = []
  for (const [sessionId, v] of totals) {
    if (v.total <= median * cfg.tokenOutlierFactor) continue
    signals.push({
      kind: 'token-waste',
      key: `token-waste:session:${sessionId}`,
      occurrences: 1,
      wastedTokensEstimate: Math.round(v.total - median),
      sessionIds: [sessionId],
      evidence: v.last
        ? [
            {
              sessionId,
              seq: v.last.seq,
              time: v.last.time,
              summary: `会话总用量 ${v.total} tokens = 中位数(${median}) 的 ${(v.total / median).toFixed(1)} 倍`,
            },
          ]
        : [],
    })
  }
  return signals.sort((a, b) => b.wastedTokensEstimate - a.wastedTokensEstimate)
}

/* ------------------------------- 工具 ------------------------------------ */

function medianOutputTokens(events: RawEvent[]): number {
  const outs = events
    .filter((e) => e.type === 'assistant/message' && e.usage)
    .map((e) => e.usage!.outputTokens)
    .sort((a, b) => a - b)
  if (outs.length === 0) return 0
  return outs[Math.floor(outs.length / 2)]!
}
