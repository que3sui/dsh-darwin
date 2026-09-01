import {
  aggregateResults,
  redactForAgent,
  type AggregateMetrics,
  type CandidatePlugin,
  type GateDecision,
  type SkillArtifact,
  type TaskResult,
} from '@dsh-darwin/protocol'
import { decideGate, DEFAULT_GATE_POLICY } from 'dsh-forge'
import { hasRelevantSkill, runTask } from './agent'
import type { TaskFamily } from './families'
import { mulberry32, type Rng } from './rng'

/**
 * P2 评测替身：真实系统里这一步由 ctx.workflow 跑子代理完成；
 * lab 里由概率 agent 直接跑。评测门用真实的 decideGate。
 * 试验是纯函数（不写入会话日志/文件系统）——对应真实系统的 fork 隔离。
 */

export interface SuiteSpec {
  visible: TaskFamily
  /** hold-out canary：expect 不可见、不可被提案引用；lab 用同族任务 */
  hidden: TaskFamily
  nVisible: number
  nHidden: number
}

export interface TrialOutcome {
  champion: AggregateMetrics
  challenger: AggregateMetrics
  decision: GateDecision
  championPassed: number
  challengerPassed: number
}

function runOne(
  family: TaskFamily,
  skills: SkillArtifact[],
  rng: Rng,
  sessionId: string,
  hidden: boolean,
): TaskResult {
  const run = runTask(family, skills, rng, sessionId)
  return {
    taskId: `${family.id}-${sessionId}`,
    passed: run.passed,
    turns: run.turns,
    tokens: run.tokens,
    durationMs: run.events.length * 2,
    hidden,
  }
}

export function runSuite(
  spec: SuiteSpec,
  skills: SkillArtifact[],
  rng: Rng,
  prefix: string,
): TaskResult[] {
  const results: TaskResult[] = []
  for (let i = 0; i < spec.nVisible; i++) {
    results.push(runOne(spec.visible, skills, rng, `${prefix}-v${i}`, false))
  }
  for (let i = 0; i < spec.nHidden; i++) {
    results.push(runOne(spec.hidden, skills, rng, `${prefix}-h${i}`, true))
  }
  return results
}

/** 任务下发唯一出口：expect/hidden 永不进入 agent 上下文（防 reward hacking） */
export function redactedPrompts(spec: SuiteSpec): Array<{ id: string; prompt: string }> {
  const tasks = [
    ...Array.from({ length: spec.nVisible }, (_, i) => ({
      id: `${spec.visible.id}-v${i}`,
      prompt: spec.visible.prompt,
      hidden: false,
      expect: { containsAll: [], matchesAny: [] },
    })),
    ...Array.from({ length: spec.nHidden }, (_, i) => ({
      id: `${spec.hidden.id}-h${i}`,
      prompt: spec.hidden.prompt,
      hidden: true,
      expect: { containsAll: [], matchesAny: [] },
    })),
  ]
  return redactForAgent({ id: 'suite', tasks, frozenAt: 0 })
}

export function evaluateCandidate(
  candidate: CandidatePlugin,
  championSkills: SkillArtifact[],
  spec: SuiteSpec,
  seed: number,
): TrialOutcome {
  const challengerSkills =
    candidate.artifact.tier === 'skill' ? [...championSkills, candidate.artifact] : championSkills

  // 冠军/挑战者各用同种子的独立流（配对比较，公平均势）
  const championResults = runSuite(spec, championSkills, mulberry32(seed), 'champ')
  const challengerResults = runSuite(spec, challengerSkills, mulberry32(seed), 'chall')

  // 断言隐藏评分器隔离：下发的任务里没有 expect
  for (const redacted of redactedPrompts(spec)) {
    if (JSON.stringify(redacted).includes('containsAll')) {
      throw new Error('评分标准泄漏进任务下发！')
    }
  }

  const champion = aggregateResults(championResults)
  const challenger = aggregateResults(challengerResults)
  const decision = decideGate(champion, challenger, DEFAULT_GATE_POLICY)
  return {
    champion,
    challenger,
    decision,
    championPassed: champion.tasksPassed,
    challengerPassed: challenger.tasksPassed,
  }
}

/** 候选技能正文命中哪个问题族（用于自动构造评测 spec） */
export function familyOfCandidate(candidate: CandidatePlugin, families: TaskFamily[]): TaskFamily | undefined {
  if (candidate.artifact.tier !== 'skill') return undefined
  const body = candidate.artifact.body.toLowerCase()
  return families.find((f) => body.includes(f.signature.toLowerCase()))
}

/** 独立技能是否对某族相关（E5 防重复技能检查用） */
export function matchesFamily(skill: SkillArtifact, family: TaskFamily): boolean {
  return hasRelevantSkill(family, [skill])
}
