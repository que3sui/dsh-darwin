import { describe, expect, it } from 'vitest'
import { fingerprintOf, PROTOCOL_VERSION } from '../src/protocol.ts'
import { distill } from '../src/distiller'
import type { Signal } from '../src/miner'

const NOW = 1_700_000_000_000

function sig(key: string, occurrences = 1, wasted = 0, kind: Signal['kind'] = 'tool-error-cluster'): Signal {
  return {
    kind,
    key,
    occurrences,
    wastedTokensEstimate: wasted,
    sessionIds: [key.split(':').pop() ?? 's1'],
    evidence: [
      { sessionId: key.split(':').pop() ?? 's1', seq: 1, time: NOW, summary: key },
    ],
  }
}

describe('distiller 信号→工单', () => {
  it('同指纹跨扫描合并而不是重复新建', () => {
    const first = distill([sig('tool-error-cluster:bash:ETIMEDOUT', 3)], [], NOW)
    expect(first.created).toHaveLength(1)

    const second = distill(
      [sig('tool-error-cluster:bash:ETIMEDOUT', 2)],
      first.tickets,
      NOW + 60_000,
    )
    expect(second.created).toHaveLength(0)
    expect(second.updated).toHaveLength(1)
    expect(second.updated[0]!.occurrences).toBe(5)
    expect(second.updated[0]!.status).toBe('open')
  })

  it('开放工单超上限时低严重度置 stale', () => {
    const { tickets } = distill(
      [sig('tool-error-cluster:tool-a:err', 10), sig('tool-error-cluster:tool-b:err', 1)],
      [],
      NOW,
      { maxOpenTickets: 1 },
    )
    const active = tickets.filter((t) => t.status === 'open')
    const stale = tickets.filter((t) => t.status === 'stale')
    expect(active).toHaveLength(1)
    expect(stale).toHaveLength(1)
    expect(active[0]!.occurrences).toBe(10)
  })

  it('resolved 工单的同指纹新信号 → 新 id，不覆盖历史', () => {
    const first = distill([sig('tool-error-cluster:x:y', 3)], [], NOW)
    const resolved = first.tickets.map((t) => ({ ...t, status: 'resolved' as const }))
    const second = distill([sig('tool-error-cluster:x:y', 3)], resolved, NOW + 1)
    expect(second.created).toHaveLength(1)
    expect(second.created[0]!.id).not.toBe(first.tickets[0]!.id)
    expect(second.created[0]!.status).toBe('open')
  })

  it('严重度排序驱动（浪费 token 越多越靠前）', () => {
    const { tickets } = distill(
      [
        sig('token-waste:session:a', 1, 100, 'token-waste'),
        sig('token-waste:session:b', 1, 50_000, 'token-waste'),
      ],
      [],
      NOW,
    )
    expect(tickets.find((t) => t.sourceSessions[0] === 'b')!.severity).toBeGreaterThan(
      tickets.find((t) => t.sourceSessions[0] === 'a')!.severity,
    )
  })

  it('产物通过 protocol schema 校验', () => {
    const { created } = distill([sig('retry-loop:session:s9', 4, 200, 'retry-loop')], [], NOW)
    expect(created[0]!.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(created[0]!.fingerprint).toBe(fingerprintOf('ticket', 'retry-loop:session:s9'))
  })
})
