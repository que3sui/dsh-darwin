/**
 * @dsh-darwin/protocol v0.1.0 — vendored single-file copy for self-contained
 * DSH plugin distribution. DSH 的 cordis 加载器以 Node 原生 ESM 直接加载 TS
 * 源码：相对导入必须带 .ts 扩展名，且不能依赖 workspace 包。因此 sentinel 与
 * forge 各内联一份本文件（两份必须字节一致，由 lab 的 protocol-vendor-sync
 * 测试强制）。正本：packages/protocol/src/*，改动请先改正本再同步两份副本。
 */
import { z } from 'zod'

export const PROTOCOL_VERSION = '0.1.0'

/* ---------------------------------- 工单 ---------------------------------- */

export const TicketStatus = z.enum(['open', 'claimed', 'resolved', 'rejected', 'stale'])
export type TicketStatus = z.infer<typeof TicketStatus>

export const ProblemKind = z.enum([
  'retry-loop',
  'tool-error-cluster',
  'interrupted-turn',
  'token-waste',
  'context-bloat',
  'custom',
])
export type ProblemKind = z.infer<typeof ProblemKind>

export const Evidence = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
})
export type Evidence = z.infer<typeof Evidence>

export const ProblemTicket = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.string().min(4),
  kind: ProblemKind,
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).default(''),
  /** 0-100，由 computeSeverity 计算：频次 + 浪费 token + 新近度 */
  severity: z.number().min(0).max(100),
  /** 稳定去重键：同键工单合并（occurrences 累加）而非新建 */
  fingerprint: z.string().min(8),
  occurrences: z.number().int().positive(),
  wastedTokensEstimate: z.number().int().nonnegative().default(0),
  evidence: z.array(Evidence).max(50).default([]),
  status: TicketStatus.default('open'),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  sourceSessions: z.array(z.string()).max(200).default([]),
})
export type ProblemTicket = z.infer<typeof ProblemTicket>

/* --------------------------------- 候选插件 -------------------------------- */

/** kebab-case，与官方 SKILL.md `name` 字段规则一致（docs/subsystems/skills.md） */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SkillArtifact = z.object({
  tier: z.literal('skill'),
  skillName: z.string().regex(KEBAB),
  frontmatter: z.object({
    name: z.string().regex(KEBAB),
    description: z.string().min(1).max(500),
    whenToUse: z.string().max(500).optional(),
  }),
  body: z.string().min(1),
})
export type SkillArtifact = z.infer<typeof SkillArtifact>

export const ConfigArtifact = z.object({
  tier: z.literal('config'),
  /** cordis.patch.yml 行草稿；整行替换语义，永远 needs_human */
  patchRows: z.array(z.record(z.unknown())).min(1),
  note: z.string().default(''),
})
export type ConfigArtifact = z.infer<typeof ConfigArtifact>

export const TemplateArtifact = z.object({
  tier: z.literal('template'),
  templateId: z.string().min(1),
  params: z.record(z.unknown()).default({}),
})
export type TemplateArtifact = z.infer<typeof TemplateArtifact>

export const CodeArtifact = z.object({
  tier: z.literal('code'),
  pluginId: z.string().regex(KEBAB),
  source: z.string().min(1),
  entry: z.string().min(1),
})
export type CodeArtifact = z.infer<typeof CodeArtifact>

export const CandidateArtifact = z.discriminatedUnion('tier', [
  SkillArtifact,
  ConfigArtifact,
  TemplateArtifact,
  CodeArtifact,
])
export type CandidateArtifact = z.infer<typeof CandidateArtifact>
export type Tier = CandidateArtifact['tier']

export const CandidateStatus = z.enum([
  'draft',
  'in_trial',
  'approved',
  'rejected',
  'promoted',
  'rolled_back',
])
export type CandidateStatus = z.infer<typeof CandidateStatus>

export const CandidatePlugin = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.string().min(4),
  ticketId: z.string().min(1),
  title: z.string().min(1).max(200),
  rationale: z.string().max(2000).default(''),
  artifact: CandidateArtifact,
  status: CandidateStatus.default('draft'),
  lineageParentId: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type CandidatePlugin = z.infer<typeof CandidatePlugin>

/* --------------------------------- 评测回执 -------------------------------- */

export const AggregateMetrics = z.object({
  tasksTotal: z.number().int().nonnegative(),
  tasksPassed: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  avgTurns: z.number().nonnegative(),
  avgTokens: z.number().nonnegative(),
  /** hold-out canary（hidden 任务）翻车数，>0 一票否决 */
  hiddenFailed: z.number().int().nonnegative().default(0),
})
export type AggregateMetrics = z.infer<typeof AggregateMetrics>

export const GateVerdict = z.enum(['promote', 'reject', 'needs_human'])
export type GateVerdict = z.infer<typeof GateVerdict>

export const GateDecision = z.object({
  verdict: GateVerdict,
  reasons: z.array(z.string()).default([]),
  champion: AggregateMetrics.optional(),
  challenger: AggregateMetrics,
})
export type GateDecision = z.infer<typeof GateDecision>

export const TaskResult = z.object({
  taskId: z.string().min(1),
  passed: z.boolean(),
  turns: z.number().int().nonnegative().default(0),
  tokens: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  hidden: z.boolean().default(false),
  note: z.string().max(500).optional(),
})
export type TaskResult = z.infer<typeof TaskResult>

export const EvalReceipt = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.string().min(4),
  candidateId: z.string().min(1),
  taskSuiteId: z.string().min(1),
  champion: AggregateMetrics.optional(),
  challenger: AggregateMetrics,
  perTask: z.array(TaskResult).default([]),
  decision: GateDecision,
  decidedAt: z.number().int().nonnegative(),
})
export type EvalReceipt = z.infer<typeof EvalReceipt>

/* ---------------------------------- 谱系 ---------------------------------- */

export const LineageNode = z.object({
  id: z.string().min(4),
  kind: z.enum(['ticket', 'candidate', 'eval', 'promotion', 'rollback']),
  at: z.number().int().nonnegative(),
  refs: z
    .object({
      ticketId: z.string().optional(),
      candidateId: z.string().optional(),
      evalId: z.string().optional(),
    })
    .default({}),
  note: z.string().max(1000).optional(),
})
export type LineageNode = z.infer<typeof LineageNode>

/* ------------------------------- 技能版本快照 ------------------------------ */

/** 回滚快照：content 为 null 表示晋级前文件不存在（回滚 = 删除文件） */
export const SkillSnapshot = z.object({
  skillName: z.string().regex(KEBAB),
  content: z.string().nullable(),
  candidateId: z.string().min(1),
  savedAt: z.number().int().nonnegative(),
})
export type SkillSnapshot = z.infer<typeof SkillSnapshot>

/* ------------------------------ 指纹与相似度 ------------------------------- */

/** FNV-1a 32bit，两粒种子拼接成 16 位 hex——足够避免日常碰撞且无依赖 */
export function fnv1a(input: string): string {
  const hash = (seed: number): number => {
    let h = seed
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }
  return (hash(0x811c9dc5).toString(16).padStart(8, '0') + hash(0x9747b28c).toString(16).padStart(8, '0'))
}

/**
 * 归一化聚类键：小写化、把易变数字（时间戳/计数/路径版本号）压平成 `#`，
 * 避免 `bash:exit code 137` 和 `bash:exit code 143` 被当成两类问题。
 */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/#+/g, '#')
    .trim()
}

/** scope 用途隔离（'ticket' / 'candidate' / ...），防止不同对象撞指纹 */
export function fingerprintOf(scope: string, key: string): string {
  return fnv1a(`${scope}│${normalizeKey(key)}`)
}

/** 词级 Jaccard 相似度，用于工单/候选近重复拒绝（阈值参照 0.8，ZK-Andy 惯例） */
export function jaccardSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter((w) => w.length > 0),
    )
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

export interface SeverityInput {
  occurrences: number
  wastedTokens: number
  lastSeenAt: number
  now: number
}

/**
 * 严重度 0-100：
 *   基础分 = min(60, occurrences × 8)
 *   浪费分 = min(30, wastedTokens / 1000 × 3)   （每 1k token 计 3 分）
 *   新近分 = ≤1 天 +10，≤7 天 +5
 */
export function computeSeverity(p: SeverityInput): number {
  const base = Math.min(60, p.occurrences * 8)
  const waste = Math.min(30, (p.wastedTokens / 1000) * 3)
  const days = (p.now - p.lastSeenAt) / 86_400_000
  const recency = days <= 1 ? 10 : days <= 7 ? 5 : 0
  return Math.max(0, Math.min(100, Math.round(base + waste + recency)))
}

/* ------------------------- 回归任务与隐藏评分器 ---------------------------- */

/**
 * 回归任务集 = forge 评测门的"选择压"来源。
 *
 * 防 reward hacking 的两条铁律（贯彻 ouroboros / 隐藏评分器经验）：
 * 1. `expect`（评分标准）物理上不进入任何 agent 上下文——下发任务只能走 redactForAgent；
 * 2. `hidden: true` 的 hold-out canary 不参与提案，只在晋级前重放，翻车一票否决。
 */

export const RegressionTask = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** hidden 任务不进提案上下文，仅用于晋级门 */
  hidden: z.boolean().default(false),
  expect: z
    .object({
      containsAll: z.array(z.string()).default([]),
      /** 正则 source 数组，命中任一即可 */
      matchesAny: z.array(z.string()).default([]),
      maxTurns: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .default({}),
})
export type RegressionTask = z.infer<typeof RegressionTask>

export const TaskSuite = z.object({
  id: z.string().min(1),
  tasks: z.array(RegressionTask).min(1),
  frozenAt: z.number().int().nonnegative(),
  note: z.string().max(1000).optional(),
})
export type TaskSuite = z.infer<typeof TaskSuite>

/** 评分器的唯一输入：可从会话日志导出的摘要，绝不含评分标准 */
export interface TranscriptSummary {
  finalText: string
  toolCalls: string[]
  turns: number
  tokens: number
}

export interface GradeOutcome {
  passed: boolean
  reasons: string[]
}

export function gradeTask(task: RegressionTask, transcript: TranscriptSummary): GradeOutcome {
  const reasons: string[] = []
  let passed = true

  // 语义：containsAll 与 matchesAny 同时非空时取 AND（两者都是硬性要求）
  for (const needle of task.expect.containsAll) {
    if (!transcript.finalText.includes(needle)) {
      passed = false
      reasons.push(`missing: "${needle}"`)
    }
  }
  if (task.expect.matchesAny.length > 0) {
    let matched = false
    for (const source of task.expect.matchesAny) {
      try {
        if (new RegExp(source).test(transcript.finalText)) {
          matched = true
          break
        }
      } catch {
        passed = false
        reasons.push(`invalid regex: /${source}/`)
        matched = true // 已按失败计，不再重复报 no match
        break
      }
    }
    if (!matched) {
      passed = false
      reasons.push(`no match in [${task.expect.matchesAny.map((s) => `/${s}/`).join(', ')}]`)
    }
  }
  if (task.expect.maxTurns !== undefined && transcript.turns > task.expect.maxTurns) {
    passed = false
    reasons.push(`turns ${transcript.turns} > ${task.expect.maxTurns}`)
  }
  if (task.expect.maxTokens !== undefined && transcript.tokens > task.expect.maxTokens) {
    passed = false
    reasons.push(`tokens ${transcript.tokens} > ${task.expect.maxTokens}`)
  }
  return { passed, reasons }
}

/**
 * 把任务集下发给 agent（子代理/workflow）时的唯一合法出口：
 * 只暴露 id + prompt，expect 与 hidden 标记被物理剥离。
 */
export function redactForAgent(suite: TaskSuite): Array<{ id: string; prompt: string }> {
  return suite.tasks.map((t) => ({ id: t.id, prompt: t.prompt }))
}

export function aggregateResults(results: TaskResult[]): AggregateMetrics {
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  const hiddenFailed = results.filter((r) => r.hidden && !r.passed).length
  const avgTurns = total === 0 ? 0 : results.reduce((s, r) => s + r.turns, 0) / total
  const avgTokens = total === 0 ? 0 : results.reduce((s, r) => s + r.tokens, 0) / total
  return {
    tasksTotal: total,
    tasksPassed: passed,
    passRate: total === 0 ? 0 : passed / total,
    avgTurns,
    avgTokens,
    hiddenFailed,
  }
}

/* ---------------------------- storageDomain 约定 --------------------------- */

export const DARWIN_DOMAIN = 'darwin'

export const DARWIN_TABLES = {
  tickets: 'tickets',
  candidates: 'candidates',
  evals: 'evals',
  lineage: 'lineage',
  snapshots: 'snapshots',
} as const

export type DarwinTable = (typeof DARWIN_TABLES)[keyof typeof DARWIN_TABLES]

/** 与官方 DomainSpec 字段对齐的最小声明（version 不匹配时后端会响亮报错而非静默迁移） */
export const DOMAIN_SPEC = {
  name: DARWIN_DOMAIN,
  version: 1,
  layout: 'single',
} as const

/* --------------------------------- KV 抽象 --------------------------------- */

/**
 * 与官方 dsh-storage KvTable 对齐的最小结构切面（structural typing）。
 * 运行时传入真实的 domain.table(name) 即可；测试用 MemoryKvStore。
 * 我们只声明自己用到的四个方法——上游加字段/改签名时受影响面最小。
 */

export interface KvTableLike<V> {
  get(key: string): V | undefined
  entries(): Array<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<void>
}

export class MemoryKvStore<V> implements KvTableLike<V> {
  private map = new Map<string, V>()

  get(key: string): V | undefined {
    return this.map.get(key)
  }

  entries(): Array<[string, V]> {
    return [...this.map.entries()]
  }

  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/** 表名 → 存储 的极简域抽象；wire 层负责把真实 Domain 适配成它 */
export interface DomainLike {
  table(name: string): KvTableLike<unknown>
}

/** 带 id 记录的通用集合访问（all/get/save），底层是任意 KvTableLike */
export class KvCollection<T extends { id: string }> {
  private table: KvTableLike<T>

  constructor(table: KvTableLike<T>) {
    this.table = table
  }

  async all(): Promise<T[]> {
    return [...this.table.entries()].map(([, v]) => v)
  }

  async get(id: string): Promise<T | undefined> {
    return this.table.get(id)
  }

  async save(item: T): Promise<void> {
    await this.table.put(item.id, item)
  }

  async remove(id: string): Promise<void> {
    await this.table.delete(id)
  }
}
