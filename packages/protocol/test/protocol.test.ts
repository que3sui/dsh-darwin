import { describe, expect, it } from 'vitest'
import {
  computeSeverity,
  fingerprintOf,
  fnv1a,
  jaccardSimilarity,
  normalizeKey,
} from '../src/fingerprint'
import {
  aggregateResults,
  gradeTask,
  redactForAgent,
  type RegressionTask,
  type TaskSuite,
  type TranscriptSummary,
} from '../src/tasks'
import { EvalReceipt, ProblemTicket, PROTOCOL_VERSION } from '../src/schema'

describe('fingerprint / 相似度', () => {
  it('normalizeKey 把易变数字压平，两类退出码归为一簇', () => {
    expect(normalizeKey('Bash: exit code 137')).toBe(normalizeKey('bash: exit code 143'))
  })

  it('fingerprintOf 稳定且区分 scope', () => {
    expect(fingerprintOf('ticket', 'a b c')).toBe(fingerprintOf('ticket', 'A  B c'))
    expect(fingerprintOf('ticket', 'x')).not.toBe(fingerprintOf('candidate', 'x'))
    expect(fnv1a('hello')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('jaccard 相同=1，无关≈0', () => {
    expect(jaccardSimilarity('bash 超时 ETIMEDOUT 重试', 'bash 超时 ETIMEDOUT 重试')).toBe(1)
    expect(jaccardSimilarity('apple', '呃 呃')).toBeLessThan(0.01)
  })

  it('computeSeverity 有界且对频次/浪费/新近度敏感', () => {
    const now = 1_000_000_000_000
    const base = { now, lastSeenAt: now }
    expect(computeSeverity({ ...base, occurrences: 0, wastedTokens: 0 })).toBe(10)
    expect(computeSeverity({ ...base, occurrences: 100, wastedTokens: 999_999 })).toBeLessThanOrEqual(100)
    expect(
      computeSeverity({ ...base, occurrences: 5, wastedTokens: 0 }),
    ).toBeGreaterThan(
      computeSeverity({ now, lastSeenAt: now - 30 * 86_400_000, occurrences: 5, wastedTokens: 0 }),
    )
  })
})

describe('回归任务与隐藏评分器', () => {
  const task: RegressionTask = {
    id: 'task-1',
    prompt: '修复测试',
    hidden: false,
    expect: {
      containsAll: ['PASS'],
      matchesAny: ['all .*tests? passed', '\\d+ passing'],
      maxTurns: 5,
      maxTokens: 1000,
    },
  }
  const good: TranscriptSummary = {
    finalText: 'all tests passed: PASS (3 passing)',
    toolCalls: ['bash'],
    turns: 2,
    tokens: 500,
  }

  it('全条件满足 → 通过', () => {
    expect(gradeTask(task, good).passed).toBe(true)
  })

  it('containsAll 缺失 → 不通过并给出原因', () => {
    const r = gradeTask(task, { ...good, finalText: 'nope (3 passing)' })
    expect(r.passed).toBe(false)
    expect(r.reasons.some((x) => x.startsWith('missing'))).toBe(true)
  })

  it('matchesAny 命中其一即可', () => {
    const r = gradeTask(task, { ...good, finalText: 'PASS — 12 passing' })
    expect(r.passed).toBe(true)
  })

  it('maxTurns / maxTokens 超限 → 不通过', () => {
    expect(gradeTask(task, { ...good, turns: 9 }).passed).toBe(false)
    expect(gradeTask(task, { ...good, tokens: 5000 }).passed).toBe(false)
  })

  it('redactForAgent 物理剥离 expect 与 hidden（评分器与任务下发隔离）', () => {
    const suite: TaskSuite = {
      id: 'suite-1',
      frozenAt: 0,
      tasks: [
        task,
        { ...task, id: 'task-canary', hidden: true },
      ],
    }
    for (const redacted of redactForAgent(suite)) {
      expect(Object.keys(redacted).sort()).toEqual(['id', 'prompt'])
      expect(JSON.stringify(redacted)).not.toContain('containsAll')
    }
  })

  it('aggregateResults 统计 hidden 翻车数', () => {
    const agg = aggregateResults([
      { taskId: 'a', passed: true, turns: 1, tokens: 10, durationMs: 1, hidden: false },
      { taskId: 'b', passed: true, turns: 2, tokens: 20, durationMs: 1, hidden: false },
      { taskId: 'c', passed: false, turns: 1, tokens: 30, durationMs: 1, hidden: true },
    ])
    expect(agg.tasksTotal).toBe(3)
    expect(agg.passRate).toBeCloseTo(2 / 3)
    expect(agg.hiddenFailed).toBe(1)
    expect(agg.avgTokens).toBeCloseTo(20)
  })
})

describe('schema 校验', () => {
  it('ProblemTicket roundtrip', () => {
    const ticket = ProblemTicket.parse({
      protocolVersion: PROTOCOL_VERSION,
      id: 'tkt-abc12345',
      kind: 'retry-loop',
      title: '重试环：会话 s1 短窗口内重试 3 次',
      severity: 42,
      fingerprint: 'abcd1234ef567890',
      occurrences: 3,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
    })
    expect(ticket.status).toBe('open')
    expect(ticket.wastedTokensEstimate).toBe(0)
  })

  it('EvalReceipt 接受可选冠军', () => {
    const receipt = EvalReceipt.parse({
      protocolVersion: PROTOCOL_VERSION,
      id: 'rcp-abc12345',
      candidateId: 'cnd-abc12345',
      taskSuiteId: 'suite-1',
      challenger: {
        tasksTotal: 3,
        tasksPassed: 3,
        passRate: 1,
        avgTurns: 2,
        avgTokens: 100,
        hiddenFailed: 0,
      },
      decision: { verdict: 'promote', reasons: ['ok'], challenger: {
        tasksTotal: 3, tasksPassed: 3, passRate: 1, avgTurns: 2, avgTokens: 100, hiddenFailed: 0,
      } },
      decidedAt: 1,
    })
    expect(receipt.champion).toBeUndefined()
  })
})
