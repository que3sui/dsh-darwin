import { describe, expect, it } from 'vitest'
import { decideGate, DEFAULT_GATE_POLICY } from '../src/gate'
import type { AggregateMetrics } from '../src/protocol.ts'

function agg(passRate: number, avgTokens = 100, hiddenFailed = 0, total = 9): AggregateMetrics {
  const passed = Math.round(total * passRate)
  return {
    tasksTotal: total,
    tasksPassed: passed,
    passRate,
    avgTurns: 3,
    avgTokens,
    hiddenFailed,
  }
}

describe('评测门决策矩阵', () => {
  it('质量提升 + 成本可控 → promote', () => {
    const d = decideGate(agg(0.66), agg(1.0, 110), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('promote')
    expect(d.reasons.join(' ')).toContain('hidden canary 全部通过')
  })

  it('低于绝对通过率下限 → reject', () => {
    const d = decideGate(agg(0.66), agg(0.6, 90), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('reject')
    expect(d.reasons[0]).toContain('下限')
  })

  it('比冠军差 → reject（回归红线）', () => {
    const d = decideGate(agg(1.0), agg(0.9, 50), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('reject')
    expect(d.reasons.join(' ')).toContain('回归')
  })

  it('hidden canary 翻车 → 一票否决（即使全绿）', () => {
    const d = decideGate(agg(0.66), agg(1.0, 100, 1), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('reject')
    expect(d.reasons[0]).toContain('hidden canary')
  })

  it('无质量收益还变贵 → reject（成本红线）', () => {
    const d = decideGate(agg(0.9), agg(0.9, 200), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('reject')
    expect(d.reasons.join(' ')).toContain('token')
  })

  it('与冠军持平 → needs_human（默认不许自动替换）', () => {
    const d = decideGate(agg(0.9), agg(0.9, 100), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('needs_human')
  })

  it('无冠军基线 → needs_human（首次晋级人工把关）', () => {
    const d = decideGate(undefined, agg(1.0), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('needs_human')
  })

  it('评测样本为空 → needs_human', () => {
    const d = decideGate(agg(0.5), agg(1.0, 100, 0, 0), DEFAULT_GATE_POLICY)
    expect(d.verdict).toBe('needs_human')
  })

  it('allowTiePromotion 开启时持平可直接晋级', () => {
    const d = decideGate(agg(0.9), agg(0.9, 100), { ...DEFAULT_GATE_POLICY, allowTiePromotion: true })
    expect(d.verdict).toBe('promote')
  })
})
