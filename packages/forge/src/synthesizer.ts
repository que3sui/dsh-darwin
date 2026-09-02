import {
  CandidatePlugin,
  fingerprintOf,
  PROTOCOL_VERSION,
  type ProblemTicket,
  type Tier,
} from './protocol.ts'

/**
 * 分级合成。风险从低到高：
 *   config（patch 行草稿，零执行）→ skill（纯 Markdown，官方热重载）
 *   → template（声明式模板实例，P2）→ code（cordis_define 自由代码，P3 前禁用）
 * MVP 默认只开 config/skill 两级——官方明言 vm 沙箱不是安全边界，
 * 在有可靠试挂+回归门之前不碰代码合成。
 */

export interface SynthConfig {
  enabledTiers: Tier[]
  author: string
}

export const DEFAULT_SYNTH_CONFIG: SynthConfig = {
  enabledTiers: ['skill', 'config'],
  author: 'dsh-forge@0.1.0 (template)',
}

export class TierDisabledError extends Error {
  constructor(tier: Tier) {
    super(`[dsh-forge] 合成层级 "${tier}" 未启用（enabledTiers 见配置）；code 级计划在 P3 且默认关闭`)
  }
}

export function synthesizeCandidate(
  ticket: ProblemTicket,
  config: SynthConfig,
  now: number,
): CandidatePlugin {
  const tier = pickTier(ticket, config.enabledTiers)
  const fp = fingerprintOf('candidate', `${ticket.fingerprint}:${tier}`)
  const id = `cnd-${fp.slice(0, 16)}`

  const artifact =
    tier === 'skill'
      ? synthesizeSkill(ticket)
      : tier === 'config'
        ? synthesizeConfig(ticket)
        : (() => {
            throw new TierDisabledError(tier)
          })()

  return CandidatePlugin.parse({
    protocolVersion: PROTOCOL_VERSION,
    id,
    ticketId: ticket.id,
    title: `修复：${ticket.title}`,
    rationale: `由工单 ${ticket.id}（severity=${ticket.severity}，累计 ${ticket.occurrences} 次）模板合成；${config.author}`,
    artifact,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  })
}

/** code 级未启用时降级到可用层级 */
export function pickTier(ticket: ProblemTicket, enabled: Tier[]): Tier {
  for (const t of orderFor(ticket.kind)) {
    if (enabled.includes(t)) return t
  }
  throw new TierDisabledError(orderFor(ticket.kind)[0] ?? 'skill')
}

function orderFor(kind: ProblemTicket['kind']): Tier[] {
  switch (kind) {
    case 'retry-loop':
    case 'tool-error-cluster':
      return ['skill', 'config']
    case 'token-waste':
    case 'context-bloat':
      return ['config', 'skill']
    case 'interrupted-turn':
      return ['skill', 'config']
    default:
      return ['skill', 'config']
  }
}

/* --------------------------------- skill 级 -------------------------------- */

function synthesizeSkill(ticket: ProblemTicket) {
  const skillName = `darwin-fix-${fingerprintOf('skill', ticket.fingerprint).slice(0, 8)}`
  const evidenceLines = ticket.evidence
    .slice(-5)
    .map((e) => `- [${e.sessionId}#${e.seq}] ${e.summary}`)
    .join('\n')

  return {
    tier: 'skill' as const,
    skillName,
    frontmatter: {
      name: skillName,
      description: `规避已监测到的「${ticket.title}」（dsh-sentinel 工单 ${ticket.id}）`.slice(0, 500),
      whenToUse: '当任务情境与下方症状匹配时',
    },
    body: [
      `## 背景（来自 dsh-sentinel 工单 ${ticket.id}）`,
      '',
      `- 症状：${ticket.title}`,
      `- 累计 ${ticket.occurrences} 次，估计浪费 ~${ticket.wastedTokensEstimate} tokens`,
      '',
      '### 证据（最近样本）',
      evidenceLines || '-（无）',
      '',
      '## 行为指引',
      '',
      '1. 动手前先复述你将采取的规避步骤，确认与本技能一致；',
      '2. 若上一次同类操作刚失败，先改变方法而不是原样重试；',
      '3. 连续两次失败后停下来向用户说明，而不是继续消耗会话。',
      '',
      '---',
      `_本技能由 ${DEFAULT_SYNTH_CONFIG.author} 从会话证据模板生成，欢迎人工润色。_`,
    ].join('\n'),
  }
}

/* --------------------------------- config 级 ------------------------------- */

function synthesizeConfig(ticket: ProblemTicket) {
  return {
    tier: 'config' as const,
    patchRows: [
      {
        // 整行替换语义的占位行：disabled: true 保证即使被误启用也无副作用
        id: `darwin-config-${fingerprintOf('config', ticket.fingerprint).slice(0, 8)}`,
        name: 'dsh-forge-config-suggestion',
        disabled: true,
        config: {},
      },
    ],
    note: `针对工单 ${ticket.id} 的配置行草稿（占位）。config 级晋级永远 needs_human，需人工改写 config 后再启用。`,
  }
}
