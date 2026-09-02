import {
  DARWIN_TABLES,
  DOMAIN_SPEC,
  KvCollection,
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
 */

export interface ForgeServices {
  tickets: KvCollection<ProblemTicket>
  candidates: CandidateStore
  snapshots: SnapshotStore
  lineage: KvCollection<LineageNode>
}

export interface ForgeContext {
  storageDomain?: {
    open?: (spec: unknown) => { table(name: string): KvTableLike<unknown> }
  }
  tools?: { register?: (tool: unknown) => unknown }
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
}

export function wireForge(ctx: ForgeContext): ForgeServices {
  const open = ctx.storageDomain?.open

  if (typeof open !== 'function') {
    ctx.logger?.warn?.('[dsh-forge] 无 ctx.storageDomain，退化为内存存储（重启即失）')
    return {
      tickets: new KvCollection<ProblemTicket>(memoryKv<ProblemTicket>()),
      candidates: new MemoryCandidateStore(),
      snapshots: new MemorySnapshotStore(),
      lineage: new KvCollection<LineageNode>(memoryKv<LineageNode>()),
    }
  }

  // TODO(verify 0.1.x)：官方 DomainSpec 的 tables 需要 domainTable(zod) 包装，
  // 预览期形状以运行时为准；forge 没有共享域就无法工作，失败要响亮抛出。
  const domain = open({
    ...DOMAIN_SPEC,
    tables: {
      [DARWIN_TABLES.tickets]: {},
      [DARWIN_TABLES.candidates]: {},
      [DARWIN_TABLES.snapshots]: {},
      [DARWIN_TABLES.lineage]: {},
    },
  })

  return {
    tickets: new KvCollection<ProblemTicket>(domain.table(DARWIN_TABLES.tickets) as KvTableLike<ProblemTicket>),
    candidates: new DomainCandidateStore(domain.table(DARWIN_TABLES.candidates) as KvTableLike<CandidatePlugin>),
    snapshots: new DomainSnapshotStore(domain.table(DARWIN_TABLES.snapshots) as KvTableLike<SkillSnapshot>),
    lineage: new KvCollection<LineageNode>(domain.table(DARWIN_TABLES.lineage) as KvTableLike<LineageNode>),
  }
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
