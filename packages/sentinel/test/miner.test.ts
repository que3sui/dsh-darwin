import { describe, expect, it } from 'vitest'
import { mineSessions } from '../src/miner'
import type { RawEvent, SessionFrame } from '../src/events'

function ev(partial: Partial<RawEvent> & { type: RawEvent['type']; seq: number; time: number }): RawEvent {
  return { sessionId: 's-default', ...partial }
}

function frame(id: string, events: RawEvent[]): SessionFrame {
  return { ref: { id }, events }
}

const T0 = 1_700_000_000_000

describe('miner 机械挖掘', () => {
  it('检测重试环：窗口内 ≥3 次 llm/retry，浪费=次数×中位输出', () => {
    const events: RawEvent[] = []
    for (let i = 0; i < 4; i++) {
      events.push(ev({ type: 'assistant/message', seq: i * 10, time: T0 + i * 60_000, usage: { inputTokens: 100, outputTokens: 50 }, turn: i }))
      events.push(ev({ type: 'llm/retry', seq: i * 10 + 1, time: T0 + i * 60_000 + 1_000, turn: i }))
    }
    const signals = mineSessions([frame('s1', events)])
    const retry = signals.find((s) => s.kind === 'retry-loop')
    expect(retry).toBeDefined()
    expect(retry!.occurrences).toBe(4)
    expect(retry!.wastedTokensEstimate).toBe(4 * 50)
  })

  it('稀疏重试（超出窗口）不误报', () => {
    const events = [0, 1, 2].map((i) =>
      ev({ type: 'llm/retry', seq: i, time: T0 + i * 60 * 60_000 }),
    )
    expect(mineSessions([frame('s1', events)]).filter((s) => s.kind === 'retry-loop')).toHaveLength(0)
  })

  it('跨会话聚合工具错误簇', () => {
    const frames = ['a', 'b', 'c'].map((id, i) =>
      frame(id, [ev({ sessionId: id, type: 'tool/result', seq: i, time: T0 + i, name: 'bash', errorCode: 'ETIMEDOUT', errorText: 'timeout after 120s' })]),
    )
    const signals = mineSessions(frames)
    const cluster = signals.find((s) => s.kind === 'tool-error-cluster')
    expect(cluster).toBeDefined()
    expect(cluster!.key).toBe('tool-error-cluster:bash:ETIMEDOUT')
    expect(cluster!.occurrences).toBe(3)
    expect(cluster!.sessionIds).toHaveLength(3)
  })

  it('检测高频中断', () => {
    const events = [0, 1].map((i) =>
      ev({ type: 'turn/end', seq: i, time: T0 + i, interrupted: true, turn: i }),
    )
    const signals = mineSessions([frame('s1', events)])
    expect(signals.find((s) => s.kind === 'interrupted-turn')).toBeDefined()
  })

  it('Token 浪费离群：≥4 会话才启用中位数', () => {
    const small = (id: string, total: number): SessionFrame =>
      frame(id, [
        ev({ type: 'assistant/message', seq: 0, time: T0, usage: { inputTokens: total - 10, outputTokens: 10 } }),
      ])
    const frames = [
      small('n1', 1000),
      small('n2', 1100),
      small('n3', 900),
      small('n4', 1050),
      small('big', 9000),
    ]
    const signals = mineSessions(frames)
    const waste = signals.find((s) => s.kind === 'token-waste')
    expect(waste).toBeDefined()
    expect(waste!.sessionIds).toEqual(['big'])
    expect(waste!.wastedTokensEstimate).toBe(9000 - 1050)

    // 只有 3 个会话 → 中位数无意义，跳过
    expect(mineSessions(frames.slice(0, 3)).filter((s) => s.kind === 'token-waste')).toHaveLength(0)
  })

  it('干净会话零误报', () => {
    const clean = frame('ok', [
      ev({ type: 'tool/call', seq: 0, time: T0, name: 'bash' }),
      ev({ type: 'tool/result', seq: 1, time: T0 + 1 }),
      ev({ type: 'turn/end', seq: 2, time: T0 + 2, turnEndReason: 'completed' }),
    ])
    expect(mineSessions([clean])).toHaveLength(0)
  })
})
