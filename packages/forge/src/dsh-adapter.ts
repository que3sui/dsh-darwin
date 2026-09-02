import {
  DARWIN_DOMAIN,
  DARWIN_TABLES,
  KvCollection,
  darwinDomainSpec,
  type CandidatePlugin,
  type KvTableLike,
  type LineageNode,
  type ProblemTicket,
  type SkillSnapshot,
} from './protocol.ts'
import {
  DomainCandidateStore,
  DomainSnapshotStore,
  MemoryCandidateStore,
  MemorySnapshotStore,
  type CandidateStore,
  type SnapshotStore,
} from './store.ts'

/**
 * ★ 上游隔离层：forge 唯一接触真实 DSH 服务形状的地方（同 sentinel/dsh-adapter 约定）。
 *
 * VERIFIED 0.1.1-rc.2（实机，2026-09-02）：
 * - ctx.storageDomain.open(spec)：异步、必须以方法形式调用（解构会丢 this）、
 *   tables 项为 { valueSchema: zod }；同名域 already-open，须先 get() 再 open()。
 * - sentinel 与 forge 共用 darwinDomainSpec()（表集一致），谁先开都行。
 */

export interface ForgeServices {
  tickets: KvCollection<ProblemTicket>
  candidates: CandidateStore
  snapshots: SnapshotStore
  lineage: KvCollection<LineageNode>
}

interface StorageDomainService {
  get(name: string): { table(name: string): KvTableLike<unknown> } | undefined
  open(spec: unknown): Promise<{ table(name: string): KvTableLike<unknown> }>
}

export interface ForgeContext {
  storageDomain?: StorageDomainService
  tools?: { register?: (tool: unknown) => unknown }
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
}

export async function wireForge(ctx: ForgeContext): Promise<ForgeServices> {
  const svc = ctx.storageDomain
  try {
    if (svc && typeof svc.open === 'function') {
      const domain = svc.get(DARWIN_DOMAIN) ?? (await svc.open(darwinDomainSpec()))
      return {
        tickets: new KvCollection<ProblemTicket>(
          domain.table(DARWIN_TABLES.tickets) as KvTableLike<ProblemTicket>,
        ),
        candidates: new DomainCandidateStore(
          domain.table(DARWIN_TABLES.candidates) as KvTableLike<CandidatePlugin>,
        ),
        snapshots: new DomainSnapshotStore(
          domain.table(DARWIN_TABLES.snapshots) as KvTableLike<SkillSnapshot>,
        ),
        lineage: new KvCollection<LineageNode>(
          domain.table(DARWIN_TABLES.lineage) as KvTableLike<LineageNode>,
        ),
      }
    }
    ctx.logger?.warn?.('[dsh-forge] 无 ctx.storageDomain，退化为内存存储（重启即失）')
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-forge] storageDomain 打开失败，退化为内存存储：${String(err)}`)
  }
  return memoryServices()
}

/** 内存 KvTable（测试/无 storageDomain 退化场景） */
function memoryKv<V>(): KvTableLike<V> {
  const mem = new Map<string, V>()
  return {
    get: (id) => mem.get(id),
    entries: () => [...mem.entries()],
    put: async (id, v) => {
      mem.set(id, v)
    },
    delete: async (id) => {
      mem.delete(id)
    },
  }
}

function memoryServices(): ForgeServices {
  return {
    tickets: new KvCollection<ProblemTicket>(memoryKv<ProblemTicket>()),
    candidates: new MemoryCandidateStore(),
    snapshots: new MemorySnapshotStore(),
    lineage: new KvCollection<LineageNode>(memoryKv<LineageNode>()),
  }
}
