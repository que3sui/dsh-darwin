import { z } from 'zod'

/**
 * dsh-evolution-protocol v0.1.0
 *
 * dsh-darwin-sentinel（信号源）与 dsh-darwin-forge（插件工厂）之间的全部合同。
 * 两个插件只通过 storageDomain 共享域 + 本 schema 通信，彼此不 import。
 * 参照 dsh-memento 的 dsh-memory-protocol v1 先例，目标是可独立演化的事实标准。
 */

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
