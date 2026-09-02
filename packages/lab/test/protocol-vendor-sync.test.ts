import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('vendored protocol 副本一致性', () => {
  it('sentinel 与 forge 的内联 protocol.ts 字节一致（防漂移守护）', () => {
    const a = readFileSync(`${root}/packages/sentinel/src/protocol.ts`, 'utf8')
    const b = readFileSync(`${root}/packages/forge/src/protocol.ts`, 'utf8')
    expect(a, '两份 vendored protocol 不一致：请改正本 packages/protocol/src/* 后同步两份副本').toBe(b)
  })

  it('vendored 副本与正本行为一致（黄金向量）', async () => {
    const sentinelProtocol = await import(`${root}/packages/sentinel/src/protocol.ts`)
    const canonical = await import('@dsh-darwin/protocol')
    const sample = {
      protocolVersion: '0.1.0',
      id: 'tkt-abc1234567890',
      kind: 'retry-loop',
      title: '重试环：s1 内重试 3 次',
      severity: 34,
      fingerprint: 'aa11bb22cc33dd44',
      occurrences: 3,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
    }
    expect(sentinelProtocol.fingerprintOf('ticket', 'Bash exit 137')).toBe(
      canonical.fingerprintOf('ticket', 'bash exit 143'),
    )
    expect(sentinelProtocol.PROTOCOL_VERSION).toBe(canonical.PROTOCOL_VERSION)
    expect(sentinelProtocol.ProblemTicket.parse(sample).id).toBe(
      canonical.ProblemTicket.parse(sample).id,
    )
    expect(sentinelProtocol.jaccardSimilarity('a b', 'a b')).toBe(1)
  })
})
