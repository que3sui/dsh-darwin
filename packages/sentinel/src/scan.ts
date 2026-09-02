import type { ProblemTicket } from './protocol.ts'
import type { SessionFrame } from './events.ts'
import type { MinerConfig, Signal } from './miner.ts'
import { mineSessions } from './miner.ts'
import { distill, type DistillerConfig } from './distiller.ts'
import type { TicketStore } from './store.ts'
import type { SessionQueryPort } from './dsh-adapter.ts'

export interface ScanDeps {
  query: SessionQueryPort
  store: TicketStore
  config?: Partial<MinerConfig & DistillerConfig>
  now?: () => number
}

export interface ScanSummary {
  scannedSessions: number
  signals: number
  created: number
  updated: number
  topSeverity: number
  topTitle?: string
}

/** 一轮完整扫描：拉最近会话 → 挖掘 → 与既有工单合并 → 落库 */
export async function scanOnce(deps: ScanDeps): Promise<ScanSummary> {
  const now = deps.now ?? Date.now
  const refs = await deps.query.listRecentSessions(
    deps.config?.lookbackSessions ?? 30,
  )
  const frames: SessionFrame[] = []
  for (const ref of refs) {
    frames.push({ ref, events: await deps.query.loadEvents(ref) })
  }

  const signals: Signal[] = mineSessions(frames, deps.config)
  const existing = await deps.store.all()
  const { tickets, created, updated } = distill(signals, existing, now(), deps.config)
  await deps.store.saveMany(tickets)

  const open = tickets
    .filter((t: ProblemTicket) => t.status === 'open')
    .sort((a, b) => b.severity - a.severity)
  return {
    scannedSessions: frames.length,
    signals: signals.length,
    created: created.length,
    updated: updated.length,
    topSeverity: open[0]?.severity ?? 0,
    topTitle: open[0]?.title,
  }
}
