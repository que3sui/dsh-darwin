/**
 * storageDomain 共享域约定。
 *
 * sentinel 与 forge 各自通过 `ctx.storageDomain.open(spec)` 打开同一个命名域
 * `darwin`，用表名隔离读写。`DOMAIN_SPEC` 是按官方 dsh-storage-domain 文档
 * 形状给出的声明；`defineDomain/domainTable` 等官方 helper 在运行时若可用
 * 应优先使用（见各插件 dsh-adapter.ts 的探测逻辑）。
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

/** 与官方 DomainSpec 字段对齐的最小声明（version 不匹配时后端会响亮报错而非静默迁移） */
export const DOMAIN_SPEC = {
  name: DARWIN_DOMAIN,
  version: 1,
  layout: 'single',
} as const
