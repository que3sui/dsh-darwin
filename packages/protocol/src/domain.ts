import { ProblemTicket, CandidatePlugin, EvalReceipt, LineageNode, SkillSnapshot } from './schema.ts'

/**
 * storageDomain 共享域约定。
 *
 * sentinel 与 forge 各自通过 `ctx.storageDomain.open(spec)` 打开同一个命名域
 * `darwin`，用表名隔离读写。
 *
 * VERIFIED against dsh-storage-domain 0.1.1-rc.2（实机核销 2026-09-02）：
 * - open(spec) 是 async，且必须作为服务方法调用（解构脱离会丢 this）；
 * - tables 项形状为 domainTable(zod) → { valueSchema }；
 * - 同名域 already-open 直接抛错——两个插件必须共用同一份 spec，
 *   先 get(name) 取已有句柄，没有才 open。
 */

export const DARWIN_DOMAIN = 'darwin'

export const DARWIN_TABLES = {
  tickets: 'tickets',
  candidates: 'candidates',
  evals: 'evals',
  lineage: 'lineage',
  snapshots: 'snapshots',
} as const

export type DarwinTable = (typeof DARWIN_TABLES)[keyof typeof DARWIN_TABLES]

/** sentinel 与 forge 共用的域声明（表集一致，谁先开都行） */
export function darwinDomainSpec() {
  return {
    name: DARWIN_DOMAIN,
    version: 1,
    tables: {
      [DARWIN_TABLES.tickets]: { valueSchema: ProblemTicket },
      [DARWIN_TABLES.candidates]: { valueSchema: CandidatePlugin },
      [DARWIN_TABLES.evals]: { valueSchema: EvalReceipt },
      [DARWIN_TABLES.lineage]: { valueSchema: LineageNode },
      [DARWIN_TABLES.snapshots]: { valueSchema: SkillSnapshot },
    },
  }
}
