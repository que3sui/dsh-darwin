import type { CandidatePlugin, LineageNode, ProblemTicket } from './protocol.ts'
import type { ForgeServices } from './dsh-adapter.ts'
import { pickNextTicket, findNearDuplicate, markClaimed } from './consumer.ts'
import { synthesizeCandidate, DEFAULT_SYNTH_CONFIG, type SynthConfig } from './synthesizer.ts'

/**
 * VERIFIED 0.1.1-rc.2（实机）：ctx.tools.register 强制 output = { schema, render, presentationMeta? }；
 * parameters 必须是完整 JSON Schema（{ type: 'object', properties, required? }），
 * 属性映射风格会被模型 API 拒绝（got 'type: null'）。
 */
export interface ToolParametersSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string }>
  required?: string[]
}

export interface ToolOutput {
  schema: Record<string, unknown>
  render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
}

const stringOutput: ToolOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export interface ForgeToolDef {
  name: string
  description: string
  parameters: ToolParametersSchema
  output: ToolOutput
  execute: (args: Record<string, unknown>) => Promise<string>
}

export interface ForgeDeps {
  services: ForgeServices
  synth?: Partial<SynthConfig>
  /** skill 晋级根目录（wire 层填，默认 <projectRoot>/.dsh/skills） */
  skillsRoot: string
  requireConfirm: boolean
}

export interface ForgeHooks {
  promoteSkill: (candidateId: string, confirm: boolean, now: number) => Promise<string>
  rollbackSkill: (skillName: string, confirm: boolean, now: number) => Promise<string>
}

/** 取下一个工单并合成候选（P1 核心编排，纯存储依赖，可单测） */
export async function forgeNextCandidate(
  deps: ForgeDeps,
  now: number,
  ticketId?: string,
): Promise<{ ticket?: ProblemTicket; candidate?: CandidatePlugin; note: string }> {
  const { services } = deps
  const tickets = await services.tickets.all()
  const ticket = ticketId ? tickets.find((t) => t.id === ticketId) : pickNextTicket(tickets)
  if (!ticket) return { note: '没有可处理的开放工单；请先在 dsh-sentinel 运行 darwin_scan' }

  const candidates = await services.candidates.all()
  const dup = findNearDuplicate(`修复：${ticket.title}`, ticket.detail, candidates)
  if (dup) {
    return {
      ticket,
      note: `工单与既有候选 ${dup.id}（${dup.status}）近重复，拒绝重复立项（防膨胀）`,
    }
  }

  const candidate = synthesizeCandidate(ticket, { ...DEFAULT_SYNTH_CONFIG, ...deps.synth }, now)
  await services.candidates.save(candidate)
  await services.tickets.save(markClaimed(ticket, now))
  const lineage: LineageNode = {
    id: `lin-${candidate.id}`,
    kind: 'candidate',
    at: now,
    refs: { ticketId: ticket.id, candidateId: candidate.id },
  }
  await services.lineage.save(lineage)

  return {
    ticket,
    candidate,
    note: '候选已生成（draft）。确认后用 darwin_promote 晋级；code 级试挂与回归门在 P2 接入。',
  }
}

export function buildForgeTools(deps: ForgeDeps, hooks: ForgeHooks): ForgeToolDef[] {
  return [
    {
      name: 'darwin_forge',
      description:
        '从问题工单合成候选修复（默认 skill/config 两级，零代码执行）。近重复工单会被拒绝重复立项。',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: '指定工单 id；缺省取严重度最高者' },
        },
      },
      output: stringOutput,
      execute: async (args) => {
        const r = await forgeNextCandidate(
          deps,
          Date.now(),
          typeof args.ticketId === 'string' ? args.ticketId : undefined,
        )
        return [
          r.note,
          r.candidate
            ? `候选 id: ${r.candidate.id}（tier=${r.candidate.artifact.tier}, status=${r.candidate.status}）`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      },
    },
    {
      name: 'darwin_promote',
      description:
        '将 skill 级候选晋级为正式技能文件（写入项目 .dsh/skills，官方热重载即时生效），并留下可回滚快照。',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: '候选 id' },
          confirm: { type: 'boolean', description: '人工确认；requireConfirm 开启时必须为 true' },
        },
        required: ['candidateId'],
      },
      output: stringOutput,
      execute: async (args) =>
        hooks.promoteSkill(String(args.candidateId ?? ''), args.confirm === true, Date.now()),
    },
    {
      name: 'darwin_rollback',
      description: '把某技能回滚到最近一次晋级前的状态（确定性恢复快照，不用 LLM 重猜）。',
      parameters: {
        type: 'object',
        properties: {
          skillName: { type: 'string', description: '技能名' },
          confirm: { type: 'boolean', description: '人工确认' },
        },
        required: ['skillName'],
      },
      output: stringOutput,
      execute: async (args) =>
        hooks.rollbackSkill(String(args.skillName ?? ''), args.confirm === true, Date.now()),
    },
  ]
}

export function renderCandidates(candidates: CandidatePlugin[]): string {
  if (candidates.length === 0) return 'dsh-forge：暂无候选。先运行 darwin_forge。'
  return candidates
    .map((c) => `- ${c.id} [${c.status}/${c.artifact.tier}] ${c.title}`)
    .join('\n')
}
