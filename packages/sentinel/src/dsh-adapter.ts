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
 * VERIFIED 0.1.1-rc.2（实机，2026-09-02，读 dsh-session-query/lib 源码）：
 * - filterSessions(filters, signal?) 是 async；返回记录形如
 *   { header: { id, createdAt, cwd, parentSession, ... }, live, persisted }，
 *   且已按新→旧排序；
 * - readSession(sessionId) 是 async，返回 { session, events:[完整原始事件] }——
 *   挖掘的唯一正确事件源；listEvents 只返回元数据索引（无 data 载荷，实测坑）；
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

type QueryService = {
  filterSessions?: (filters: unknown[], signal?: unknown) => Promise<unknown[]>
  /** VERIFIED：返回 {session, events:[完整原始事件(含 data 载荷)]}——挖掘用这个 */
  readSession?: (sessionId: string) => Promise<{ session: unknown; events: unknown[] }>
  /** VERIFIED：仅返回 {sessionId,seq,type,time,surface} 元数据索引——对挖掘无用 */
  listEvents?: (sessionId: string) => Promise<unknown[]>
  filterEvents?: (sessionId: string, filters: unknown[]) => Promise<unknown[]>
}

export function wireSessionQuery(sessionQuery: unknown): SessionQueryPort {
  const sq = sessionQuery as QueryService | undefined

  if (!sq || typeof sq.filterSessions !== 'function') {
    throw new Error(
      '[dsh-darwin-sentinel] 找不到 ctx.sessionQuery.filterSessions。' +
        '请确认 DSH >= 0.1.1 且 dsh-session-query provider 已挂载。',
    )
  }

  return {
    async listRecentSessions(limit) {
      // VERIFIED：空数组 = 匹配全部（子句必须带 kind，[{}] 会报 unknown filter kind (missing)）
      const records = (await sq.filterSessions!([])) as Array<
        Record<string, unknown> & { header?: Record<string, unknown> }
      >
      const refs = records
        .map((r) => {
          // VERIFIED：字段嵌套在 header 里（camelCase）
          const h = (r.header ?? r) as Record<string, unknown>
          return {
            id: String(h.id ?? ''),
            cwd: typeof h.cwd === 'string' ? h.cwd : undefined,
            createdAt: Number(h.createdAt) || undefined,
          }
        })
        .filter((r) => r.id !== '')
      // 官方已按新→旧排序，此处排序仅作双保险
      refs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      return refs.slice(0, limit)
    },

    async loadEvents(ref) {
      // VERIFIED（实机核销 2026-09-02）：listEvents 只返回 {sessionId,seq,type,time,surface}
      // 元数据索引（无 data 载荷）；完整原始事件必须走 readSession().events
      if (typeof sq.readSession === 'function') {
        const loaded = (await sq.readSession!(ref.id)) as {
          events: Array<Record<string, unknown>>
        }
        return toRawEvents(ref.id, loaded.events ?? [])
      }
      if (typeof sq.filterEvents === 'function') {
        const docs = (await sq.filterEvents!(ref.id, [])) as Array<Record<string, unknown>>
        return toRawEvents(ref.id, docs)
      }
      throw new Error('[dsh-darwin-sentinel] ctx.sessionQuery 缺少 readSession/filterEvents')
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

/**
 * VERIFIED（实机，2026-09-02，解压真实 session.jsonl.zstd 比对）：
 * - 信封：{type, seq, time, data: {...}}，载荷全在 data 里；
 * - tool/call：data.{turn, callId, name, arguments}；
 * - tool/result：data.{turn, message:{source:{callId}, content:[{type:'tool-result',
 *   content:[{type:'text', text}]}]}}——无结构化 error 字段，失败体现在文本
 *   （[stderr] 标记 + [exit code: N]），工具名需按 callId 从 tool/call 反查；
 * - turn/end：data.reason = {kind}（对象）；
 * - assistant/message：data.usage（可能为 null）。
 */
function toRawEvents(sessionId: string, docs: Array<Record<string, unknown>>): RawEvent[] {
  const callNames = new Map<string, string>()
  const out: RawEvent[] = []

  for (const doc of docs) {
    const type = String(doc.type ?? '')
    if (!KNOWN_TYPES.has(type as RawEventType)) continue
    const data = (doc.data ?? doc) as Record<string, unknown>
    const ev: RawEvent = {
      sessionId,
      seq: Number(doc.seq ?? 0),
      time: Number(doc.time ?? 0),
      type: type as RawEventType,
    }

    if (type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const name = String(data.name ?? '')
      if (callId && name) callNames.set(callId, name)
      ev.name = name || undefined
      ev.turn = num(data.turn)
      out.push(ev)
      continue
    }

    if (type === 'tool/result') {
      ev.turn = num(data.turn)
      const message = data.message as Record<string, unknown> | undefined
      const blocks = (message?.content ?? []) as Array<Record<string, unknown>>
      const callId = String(
        (message?.source as Record<string, unknown> | undefined)?.callId ??
          blocks[0]?.toolCallId ??
          '',
      )
      // 工具名：callId 反查（真实形状）→ 顶层 name（扁平形状回退）
      const name = callNames.get(callId) ?? (data.name != null ? String(data.name) : undefined)
      if (name) ev.name = name
      const text = blocks
        .flatMap((b) => (b.content as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => String(c.text ?? ''))
        .join('\n')
      const fail = parseToolFailure(text)
      if (fail) {
        ev.errorCode = fail.code
        ev.errorText = fail.firstLine
      } else if (data.errorCode != null || data.error != null) {
        // 扁平回退：RawEvent 风格的直写字段（lab/内存路径）
        const derr = data.error
        ev.errorCode =
          data.errorCode != null
            ? String(data.errorCode)
            : derr && typeof derr === 'object'
              ? String((derr as Record<string, unknown>).code ?? (derr as Record<string, unknown>).name)
              : String(derr)
        if (data.errorText != null) ev.errorText = String(data.errorText)
      }
      out.push(ev)
      continue
    }

    if (type === 'turn/end') {
      ev.turn = num(data.turn)
      const reason = data.reason
      if (typeof reason === 'string') {
        ev.turnEndReason = reason
        ev.interrupted = reason.toLowerCase().includes('interrupt')
      } else if (reason && typeof reason === 'object') {
        const kind = String((reason as Record<string, unknown>).kind ?? '')
        ev.turnEndReason = kind
        ev.interrupted = kind.toLowerCase().includes('interrupt')
      } else {
        // 扁平回退：直写 turnEndReason / interrupted（lab/内存路径）
        if (data.turnEndReason != null) ev.turnEndReason = String(data.turnEndReason)
        if (data.interrupted === true) ev.interrupted = true
      }
      out.push(ev)
      continue
    }

    // assistant/message / llm/retry
    ev.turn = num(data.turn)
    const usage = data.usage as Record<string, unknown> | null | undefined
    if (usage && typeof usage === 'object') {
      ev.usage = {
        inputTokens: Number(usage.inputTokens ?? usage.input ?? 0),
        outputTokens: Number(usage.outputTokens ?? usage.output ?? 0),
      }
    }
    out.push(ev)
  }
  return out
}

function num(v: unknown): number | undefined {
  return v == null ? undefined : Number(v)
}

/**
 * 失败启发式：[stderr] 标记或非零 [exit code: N]。
 * 聚类键只用退出码（语言无关——实测 PowerShell 同一错误会因本地化输出中/英混排，
 * 按 stderr 首行聚类会把同类失败拆散）；消息全文降级为证据明细。
 */
function parseToolFailure(text: string): { code: string; firstLine: string } | undefined {
  if (!text) return undefined
  const exitMatch = /\[exit code:\s*(\d+)\]/.exec(text)
  const failed = text.includes('[stderr]') || (exitMatch !== null && exitMatch[1] !== '0')
  if (!failed) return undefined
  const stderrIdx = text.indexOf('[stderr]')
  const tail = stderrIdx >= 0 ? text.slice(stderrIdx + '[stderr]'.length) : text
  const firstLine = tail.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'unknown-error'
  const code = exitMatch ? `exit-${exitMatch[1]}` : 'stderr'
  return { code, firstLine: firstLine.slice(0, 200) }
}

/* ------------------------------ 工单存储 --------------------------------- */

export async function wireTicketStore(
  storageDomain: StorageDomainService | undefined,
  log?: SentinelContext['logger'],
): Promise<TicketStore> {
  try {
    if (storageDomain && typeof storageDomain.open === 'function') {
      const domain = await openOrAttach(storageDomain, log)
      const table = domain.table(DARWIN_TABLES.tickets) as KvTableLike<ProblemTicket>
      return new DomainTicketStore(table)
    }
    log?.warn?.('[dsh-darwin-sentinel] 无 ctx.storageDomain，使用内存工单库（重启即失）')
  } catch (err) {
    log?.warn?.(
      `[dsh-darwin-sentinel] storageDomain 打开失败，回退内存工单库（重启即失）：${String(err)}`,
    )
  }
  return new MemoryTicketStore()
}

/**
 * 并发安全的 get-or-open（VERIFIED 实机踩坑）：
 * sentinel/forge 同时启动时会竞态——先到者 open() 在途（域名已进 reserved
 * 但未注册 domains），后到者 get() 为 undefined、再 open() 撞 already-open。
 * 撞上 already-open 不降级，轮询 get() 等先到者注册完成（共享同一句柄）。
 */
export async function openOrAttach(
  svc: StorageDomainService,
  log?: SentinelContext['logger'],
): Promise<{ table(name: string): KvTableLike<unknown> }> {
  const attached = svc.get(DARWIN_DOMAIN)
  if (attached) return attached
  try {
    return await svc.open(darwinDomainSpec())
  } catch (err) {
    // VERIFIED：官方 DomainError code='already-open'（连字符），message 为 "is already open"（空格）
    const e = err as { code?: string; message?: string }
    const isAlreadyOpen =
      e?.code === 'already-open' ||
      String(e?.message ?? '').replace(/-/g, ' ').includes('already open')
    if (!isAlreadyOpen) throw err
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const got = svc.get(DARWIN_DOMAIN)
      if (got) {
        log?.info?.('[dsh-darwin-sentinel] 已挂载到先行者打开的 darwin 共享域')
        return got
      }
    }
    throw new Error('darwin 域被并发打开但等待句柄超时（2s）')
  }
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
