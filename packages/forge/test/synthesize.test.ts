import { describe, expect, it } from 'vitest'
import { ProblemTicket } from '@dsh-darwin/protocol'
import { synthesizeCandidate, DEFAULT_SYNTH_CONFIG, TierDisabledError } from '../src/synthesizer'
import { pickNextTicket, findNearDuplicate, markClaimed } from '../src/consumer'
import type { ProblemTicket as Ticket } from '@dsh-darwin/protocol'

const NOW = 1_700_000_000_000

function ticket(partial: Partial<Ticket> = {}): Ticket {
  return ProblemTicket.parse({
    protocolVersion: '0.1.0',
    id: 'tkt-test000000000',
    kind: 'tool-error-cluster',
    title: '工具错误簇：bash:ETIMEDOUT 累计失败 5 次',
    severity: 50,
    fingerprint: 'aa11bb22cc33dd44',
    occurrences: 5,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    detail: 'bash 超时反复出现',
    ...partial,
  })
}

describe('分级合成', () => {
  it('skill 级候选：frontmatter 合法、kebab 名称、证据写入正文', () => {
    const c = synthesizeCandidate(ticket(), DEFAULT_SYNTH_CONFIG, NOW)
    expect(c.status).toBe('draft')
    expect(c.artifact.tier).toBe('skill')
    if (c.artifact.tier === 'skill') {
      expect(c.artifact.frontmatter.name).toBe(c.artifact.skillName)
      expect(c.artifact.skillName).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(c.artifact.body).toContain('ETIMEDOUT')
      expect(c.artifact.body).toContain('行为指引')
    }
  })

  it('未启用层级 → TierDisabledError', () => {
    expect(() =>
      synthesizeCandidate(ticket(), { ...DEFAULT_SYNTH_CONFIG, enabledTiers: [] }, NOW),
    ).toThrow(TierDisabledError)
  })

  it('code 级默认不可达（零代码执行的安全默认）', () => {
    expect(DEFAULT_SYNTH_CONFIG.enabledTiers).not.toContain('code')
    expect(DEFAULT_SYNTH_CONFIG.enabledTiers).not.toContain('template')
  })

  it('token-waste 类问题优先 config 级且 patch 行必须 disabled', () => {
    const c = synthesizeCandidate(
      ticket({ kind: 'token-waste', title: 'Token 浪费' }),
      DEFAULT_SYNTH_CONFIG,
      NOW,
    )
    expect(c.artifact.tier).toBe('config')
    if (c.artifact.tier === 'config') {
      expect(c.artifact.patchRows[0]).toMatchObject({ disabled: true })
    }
  })
})

describe('工单消费与近重复拒绝', () => {
  it('pickNextTicket 取 open 中严重度最高者', () => {
    const a = ticket({ id: 'tkt-a0000000000000', severity: 30 })
    const b = ticket({ id: 'tkt-b0000000000000', severity: 90 })
    const resolved = ticket({ id: 'tkt-c0000000000000', severity: 99, status: 'resolved' })
    expect(pickNextTicket([a, resolved, b])?.id).toBe('tkt-b0000000000000')
  })

  it('markClaimed 不修改原对象', () => {
    const t = ticket()
    const claimed = markClaimed(t, NOW + 1)
    expect(t.status).toBe('open')
    expect(claimed.status).toBe('claimed')
  })

  it('近重复拒绝：同题候选 ≥0.8 命中，异题放行', () => {
    const existing = [synthesizeCandidate(ticket(), DEFAULT_SYNTH_CONFIG, NOW)]
    expect(findNearDuplicate('修复：工具错误簇：bash:ETIMEDOUT 累计失败 5 次', '', existing)).toBeDefined()
    expect(findNearDuplicate('完全无关的另一件事', '', existing)).toBeUndefined()
  })
})
