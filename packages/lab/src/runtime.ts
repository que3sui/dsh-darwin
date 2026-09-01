import {
  MemoryKvStore,
  type CandidatePlugin,
  type KvTableLike,
  type ProblemTicket,
  type SkillArtifact,
} from '@dsh-darwin/protocol'
import {
  apply as sentinelApply,
  DomainTicketStore,
  type RawEvent,
  type SessionFrame,
} from 'dsh-sentinel'
import {
  apply as forgeApply,
  DomainCandidateStore,
  MemoryFilePort,
  type CandidateStore,
  type FilePort,
} from 'dsh-forge'

/**
 * Mock DSH 运行时：内存会话日志 + 共享 storageDomain + 内存文件系统。
 * sentinel / forge 的 apply() 原封不动挂载进来——被验证的是真实插件代码。
 */

interface AnyTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<string>
}

export class MockSessionLog {
  private sessions = new Map<string, { ref: { id: string; createdAt: number }; events: RawEvent[] }>()
  private counter = 0

  addSession(events: RawEvent[]): string {
    const id = events[0]?.sessionId ?? `s-${this.counter}`
    this.counter++
    this.sessions.set(id, { ref: { id, createdAt: this.counter }, events })
    return id
  }

  get size(): number {
    return this.sessions.size
  }

  /** 对齐官方 ctx.sessionQuery.filterSessions([{}]) 的最小形状 */
  filterSessions(): Array<{ id: string; createdAt: number }> {
    return [...this.sessions.values()]
      .map((s) => ({ id: s.ref.id, createdAt: s.ref.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 对齐官方 ctx.sessionQuery.filterEvents(sessionId, [{}]) 的最小形状 */
  filterEvents(sessionId: string): Array<Record<string, unknown>> {
    const frame = this.sessions.get(sessionId)
    if (!frame) return []
    return frame.events.map((e) => ({ ...e, error: e.errorCode }))
  }

  frames(): SessionFrame[] {
    return [...this.sessions.values()].map((s) => ({ ref: s.ref, events: s.events }))
  }
}

export const SKILLS_ROOT = 'proj/.dsh/skills'

export interface Lab {
  files: MemoryFilePort
  sessionLog: MockSessionLog
  candidates: CandidateStore
  tickets: { all(): Promise<ProblemTicket[]> }
  tools: Map<string, AnyTool>
  call(name: string, args?: Record<string, unknown>): Promise<string>
  readMountedSkills(): Promise<SkillArtifact[]>
  skillNames(): Promise<string[]>
}

export function bootLab(): Lab {
  const tables = new Map<string, KvTableLike<unknown>>()
  const domain = {
    // 忽略 spec 形状（真实后端会校验 DomainSpec；mock 宽松处理）
    open: (_spec: unknown) => ({
      table: (name: string): KvTableLike<unknown> => {
        let t = tables.get(name)
        if (!t) {
          t = new MemoryKvStore()
          tables.set(name, t)
        }
        return t
      },
    }),
  }

  const sessionLog = new MockSessionLog()
  const files = new MemoryFilePort()
  const tools = new Map<string, AnyTool>()
  const register = (tool: unknown): unknown => {
    const t = tool as AnyTool
    tools.set(t.name, t)
    return t
  }
  const logger = {
    info: (...a: unknown[]) => console.log('[lab]', ...a),
    warn: (...a: unknown[]) => console.warn('[lab:warn]', ...a),
  }

  // 真实插件，原封不动
  sentinelApply(
    { sessionQuery: sessionLog, storageDomain: domain, tools: { register }, logger },
    { autoScan: false, lookbackSessions: 500 },
  )
  forgeApply(
    { storageDomain: domain, tools: { register }, logger },
    { skillsRoot: SKILLS_ROOT, files, requireConfirm: true },
  )

  const candidates = new DomainCandidateStore(
    tables.get('candidates') as KvTableLike<CandidatePlugin>,
  )
  const ticketStore = new DomainTicketStore(
    tables.get('tickets') as KvTableLike<ProblemTicket>,
  )

  const readMountedSkills = async (): Promise<SkillArtifact[]> => {
    const skills: SkillArtifact[] = []
    for (const path of files.list(`${SKILLS_ROOT}/`)) {
      if (!path.endsWith('SKILL.md')) continue
      const content = await files.read(path)
      if (content === undefined) continue
      skills.push(parseSkillFile(content))
    }
    return skills
  }

  return {
    files,
    sessionLog,
    candidates,
    tickets: ticketStore,
    tools,
    call: async (name, args = {}) => {
      const tool = tools.get(name)
      if (!tool) {
        throw new Error(`[lab] 工具未注册: ${name}（已注册: ${[...tools.keys()].join(', ')}）`)
      }
      return tool.execute(args)
    },
    readMountedSkills,
    skillNames: async () => (await readMountedSkills()).map((s) => s.skillName),
  }
}

function parseSkillFile(content: string): SkillArtifact {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content)
  const name = m?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown'
  const description = m?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const whenToUse = m?.[1]?.match(/^whenToUse:\s*(.+)$/m)?.[1]?.trim()
  const body = (m?.[2] ?? content).trim()
  return {
    tier: 'skill',
    skillName: name,
    frontmatter: { name, description, ...(whenToUse ? { whenToUse } : {}) },
    body,
  }
}

export type { FilePort }
