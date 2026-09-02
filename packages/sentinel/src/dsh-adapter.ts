import {
  DARWIN_DOMAIN,
  DARWIN_TABLES,
  MemoryKvStore,
  ProblemTicket,
  darwinDomainSpec,
  type KvTableLike,
} from './protocol.ts'
import type { RawEvent, RawEventType, SessionFrame } from './events.ts'
import type { TicketStore } from './store.ts'
import { DomainTicketStore, MemoryTicketStore } from './store.ts'

/**
 * ★ 上游隔离层：本文件是 sentinel 唯一允许接触真实 DSH 服务形状的地方。
 * 上游（deepseek-ai/deepseek-harness）处于开发预览期、保证破坏性变更，
 * 升级时只改这里。
 *
 * VERIFIED 0.1.1-rc.2（实机，2026-09-02）：
 * - ctx.sessionQuery.filterSessions / filterEvents 存在且为同步方法；
 * - ctx.storageDomain.open(spec)：异步、必须以方法形式调用（解构会丢 this）、
 *   tables 项为 { valueSchema: zod }；同名域 already-open，须先 get() 再 open()。
 */

export interface SessionRef {
  id: string
  cwd?: string
  createdAt?: number
}

export interface SessionQueryPort {
  listRecentSessions(limit: number): Promise<SessionRef[]>
  loadEvents(ref: SessionRef): Promise<RawEvent[]>
}

export interface SentinelServices {
  query: SessionQueryPort
  store: TicketStore
}

interface StorageDomainService {
  get(name: string): { table(name: string): KvTableLike<unknown> } | undefined
  open(spec: unknown): Promise<{ table(name: string): KvTableLike<unknown> }>
}

/** 结构化最小切面：真实 Cordis Context 可以结构性赋值给它 */
export interface SentinelContext {
  sessionQuery?: unknown
  storageDomain?: StorageDomainService
  tools?: { register?: (tool: unknown) => unknown }
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
}

export async function wireSentinel(ctx: SentinelContext): Promise<SentinelServices> {
  return {
    query: wireSessionQuery(ctx.sessionQuery),
    store: await wireTicketStore(ctx.storageDomain, ctx.logger),
  }
}

/* ------------------------------ 会话查询 --------------------------------- */

/** TODO(verify 0.1.x)：filterEvents 检索文档是语义文本索引（不含结构化 usage）；
 * 生产级挖掘应改用 SessionLogSnapshot（完整已验证日志）重放。 */
export function wireSessionQuery(sessionQuery: unknown): SessionQueryPort {
  const sq = sessionQuery as
    | {
        filterSessions?: (filters: unknown[]) => unknown[]
        filterEvents?: (sessionId: string, filters: unknown[]) => unknown[]
      }
    | undefined

  if (!sq || typeof sq.filterSessions !== 'function' || typeof sq.filterEvents !== 'function') {
    throw new Error(
      '[dsh-sentinel] 找不到 ctx.sessionQuery（filterSessions/filterEvents）。' +
        '请确认 DSH >= 0.1.1 且 dsh-session-query provider 已挂载。',
    )
  }

  return {
    async listRecentSessions(limit) {
      const records = sq.filterSessions!([{}]) as Array<Record<string, unknown>>
      const refs = records
        .map((r) => ({
          id: String(r.id ?? r.sessionId ?? ''),
          cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
          createdAt:
            typeof r.createdAt === 'number' ? r.createdAt : Number(r.createdAt) || undefined,
        }))
        .filter((r) => r.id !== '')
      refs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      return refs.slice(0, limit)
    },

    async loadEvents(ref) {
      const docs = sq.filterEvents!(ref.id, [{}]) as Array<Record<string, unknown>>
      return docs.map((d) => toRawEvent(ref.id, d)).filter((e): e is RawEvent => e !== undefined)
    },
  }
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<RawEventType>([
  'tool/call',
  'tool/result',
  'llm/retry',
  'turn/end',
  'assistant/message',
])

function toRawEvent(sessionId: string, d: Record<string, unknown>): RawEvent | undefined {
  const type = String(d.type ?? '')
  if (!KNOWN_TYPES.has(type as RawEventType)) return undefined
  const ev: RawEvent = {
    sessionId,
    seq: Number(d.seq ?? 0),
    time: Number(d.time ?? 0),
    type: type as RawEventType,
  }
  if (d.name != null) ev.name = String(d.name)
  if (d.error != null) ev.errorCode = String(d.error)
  if (d.errorText != null) ev.errorText = String(d.errorText)
  if (d.interrupted === true) ev.interrupted = true
  if (d.reason != null) ev.turnEndReason = String(d.reason)
  if (d.turn != null) ev.turn = Number(d.turn)
  const usage = d.usage as Record<string, unknown> | undefined
  if (usage && typeof usage === 'object') {
    ev.usage = {
      inputTokens: Number(usage.inputTokens ?? usage.input ?? 0),
      outputTokens: Number(usage.outputTokens ?? usage.output ?? 0),
    }
  }
  return ev
}

/* ------------------------------ 工单存储 --------------------------------- */

export async function wireTicketStore(
  storageDomain: StorageDomainService | undefined,
  log?: SentinelContext['logger'],
): Promise<TicketStore> {
  try {
    if (storageDomain && typeof storageDomain.open === 'function') {
      // get-or-open：sentinel/forge 谁先启动都行，域 spec 两边完全一致
      const domain =
        storageDomain.get(DARWIN_DOMAIN) ?? (await storageDomain.open(darwinDomainSpec()))
      const table = domain.table(DARWIN_TABLES.tickets) as KvTableLike<ProblemTicket>
      return new DomainTicketStore(table)
    }
    log?.warn?.('[dsh-sentinel] 无 ctx.storageDomain，使用内存工单库（重启即失）')
  } catch (err) {
    log?.warn?.(
      `[dsh-sentinel] storageDomain 打开失败，回退内存工单库（重启即失）：${String(err)}`,
    )
  }
  return new MemoryTicketStore()
}

/** 测试/离线场景：从内存表构造 */
export function memoryQuery(frames: SessionFrame[]): SessionQueryPort {
  return {
    async listRecentSessions(limit) {
      return frames.slice(0, limit).map((f) => f.ref)
    },
    async loadEvents(ref) {
      return frames.find((f) => f.ref.id === ref.id)?.events ?? []
    },
  }
}

export { MemoryKvStore }
