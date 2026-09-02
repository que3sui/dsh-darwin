import {
  computeSeverity,
  fingerprintOf,
  ProblemTicket,
  PROTOCOL_VERSION,
  type Evidence,
  type ProblemKind,
} from './protocol.ts'
import type { Signal } from './miner.ts'

/**
 * 信号 → 工单（纯函数）。
 * 同指纹合并（occurrences 累加、证据补充），跨扫描稳定；
 * 开放工单超出上限时把低严重度者标记为 stale。
 */

export interface DistillerConfig {
  /** Jaccard ≥ 阈值的同 kind 新信号并入既有工单标题族（预留，当前靠指纹） */
  nearDupThreshold: number
  maxOpenTickets: number
}

export const DEFAULT_DISTILLER_CONFIG: DistillerConfig = {
  nearDupThreshold: 0.8,
  maxOpenTickets: 50,
}

export interface DistillResult {
  /** 合并后的完整工单表（含历史 resolved/rejected，原样保留） */
  tickets: ProblemTicket[]
  created: ProblemTicket[]
  updated: ProblemTicket[]
}

export function distill(
  signals: Signal[],
  existing: ProblemTicket[],
  now: number,
  partial: Partial<DistillerConfig> = {},
): DistillResult {
  const cfg = { ...DEFAULT_DISTILLER_CONFIG, ...partial }
  const byFingerprint = new Map<string, ProblemTicket>()
  for (const t of existing) byFingerprint.set(t.fingerprint, t)

  const created: ProblemTicket[] = []
  const updated: ProblemTicket[] = []

  // 同一轮扫描内同指纹的信号先聚合
  const grouped = new Map<string, Signal[]>()
  for (const s of signals) {
    const fp = fingerprintOf('ticket', s.key)
    const list = grouped.get(fp) ?? []
    list.push(s)
    grouped.set(fp, list)
  }

  for (const [fp, sigs] of grouped) {
    const occurrences = sigs.reduce((sum, s) => sum + s.occurrences, 0)
    const wasted = sigs.reduce((sum, s) => sum + s.wastedTokensEstimate, 0)
    const evidence = mergeEvidence(sigs, cfg)
    const sessionIds = [...new Set(sigs.flatMap((s) => s.sessionIds))]
    const lastSeenAt = Math.max(
      ...sigs.flatMap((s) => s.evidence.map((e) => e.time)).concat([0]),
    )
    const prev = byFingerprint.get(fp)

    if (prev && (prev.status === 'open' || prev.status === 'claimed' || prev.status === 'stale')) {
      const next: ProblemTicket = {
        ...prev,
        occurrences: prev.occurrences + occurrences,
        wastedTokensEstimate: prev.wastedTokensEstimate + wasted,
        evidence: [...prev.evidence, ...evidence].slice(-50),
        sourceSessions: [...new Set([...prev.sourceSessions, ...sessionIds])].slice(0, 200),
        lastSeenAt: Math.max(prev.lastSeenAt, lastSeenAt),
        updatedAt: now,
      }
      next.severity = computeSeverity({
        occurrences: next.occurrences,
        wastedTokens: next.wastedTokensEstimate,
        lastSeenAt: next.lastSeenAt,
        now,
      })
      byFingerprint.set(fp, next)
      updated.push(next)
    } else {
      const kind = sigs[0]!.kind
      const severity = computeSeverity({ occurrences, wastedTokens: wasted, lastSeenAt, now })
      // 同指纹的历史工单若已 resolved/rejected，新工单用带时间的 id 避免覆盖历史
      const idBase = prev ? `${fp.slice(0, 12)}-${now.toString(36)}` : fp.slice(0, 16)
      const ticket: ProblemTicket = ProblemTicket.parse({
        protocolVersion: PROTOCOL_VERSION,
        id: `tkt-${idBase}`,
        kind,
        title: titleFor(kind, sigs[0]!, occurrences),
        severity,
        fingerprint: fp,
        occurrences,
        wastedTokensEstimate: wasted,
        evidence,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        lastSeenAt,
        sourceSessions: sessionIds.slice(0, 200),
      })
      byFingerprint.set(fp, ticket)
      created.push(ticket)
    }
  }

  // 上限治理：open/claimed 按 severity 排序，超出部分置 stale
  const all = [...byFingerprint.values()]
  const active = all
    .filter((t) => t.status === 'open' || t.status === 'claimed')
    .sort((a, b) => b.severity - a.severity)
  const staleIds = new Set(active.slice(cfg.maxOpenTickets).map((t) => t.id))
  const tickets = all.map((t) =>
    staleIds.has(t.id) ? { ...t, status: 'stale' as const, updatedAt: now } : t,
  )

  return { tickets, created, updated }
}

function mergeEvidence(sigs: Signal[], cfg: DistillerConfig): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const s of sigs) {
    for (const e of s.evidence) {
      const k = `${e.sessionId}:${e.seq}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(e)
      if (out.length >= 50) return out
    }
  }
  return out
}

function titleFor(kind: ProblemKind, s: Signal, occurrences: number): string {
  switch (kind) {
    case 'retry-loop':
      return `重试环：${shortSession(s.key)} 短窗口内重试 ${occurrences} 次`
    case 'tool-error-cluster':
      return `工具错误簇：${s.key.replace('tool-error-cluster:', '')} 累计失败 ${occurrences} 次`
    case 'interrupted-turn':
      return `高频中断：${shortSession(s.key)} 有 ${occurrences} 个回合被打断`
    case 'token-waste': {
      const e = s.evidence[0]?.summary ?? ''
      return `Token 浪费：${shortSession(s.key)}${e ? `（${e.split('（')[1]?.replace('）', '') ?? e}）` : ''}`
    }
    default:
      return `问题信号：${s.key}`
  }
}

function shortSession(key: string): string {
  return key.split(':').slice(-1)[0] ?? key
}
