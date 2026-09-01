import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { runAllExperiments } from '../src/experiments'

const REPORT_PATH = fileURLToPath(new URL('../../../LAB_REPORT.md', import.meta.url))

let results: Awaited<ReturnType<typeof runAllExperiments>>

beforeAll(async () => {
  results = await runAllExperiments()
  writeFileSync(REPORT_PATH, results.report, 'utf8')
})

describe('E1 挖掘查全/查准', () => {
  it('植入缺陷全部检出，干净会话零误报', () => {
    const d = results.sections[0]!.data as { precisionOk: boolean; recallOk: boolean; totalTickets: number }
    expect(d.totalTickets).toBeGreaterThan(0)
    expect(d.precisionOk, `干净会话被工单污染`).toBe(true)
    expect(d.recallOk, '重试环/错误簇/中断/鲸鱼未全部检出').toBe(true)
  })
})

describe('E2 端到端飞轮', () => {
  it('恰好晋级三族技能各一', () => {
    const d = results.sections[1]!.data as { signaturesOk: boolean; promotedSignatures: string[] }
    expect(d.signaturesOk, `晋级签名: ${d.promotedSignatures.join(',')}`).toBe(true)
  })
  it('配对重放：成功率 +≥25pt 且平均 token 下降', () => {
    const d = results.sections[1]!.data as {
      improved: boolean
      pre: { passRate: number; avgTokens: number }
      post: { passRate: number; avgTokens: number }
    }
    expect(d.post.passRate, `成功率 ${d.pre.passRate} → ${d.post.passRate}`).toBeGreaterThanOrEqual(
      d.pre.passRate + 0.25,
    )
    expect(d.post.avgTokens, `token ${d.pre.avgTokens} → ${d.post.avgTokens}`).toBeLessThan(d.pre.avgTokens)
    expect(d.improved).toBe(true)
  })
})

describe('E3 评测门对抗', () => {
  it('过拟合候选被 hold-out canary 否决', () => {
    const d = results.sections[2]!.data as { overfit: { overfitRejected: boolean; hiddenFailed: number } }
    expect(d.overfit.overfitRejected, `canary 翻车 ${d.overfit.hiddenFailed}`).toBe(true)
  })
  it('持平但变贵的候选被成本红线拒绝', () => {
    const d = results.sections[2]!.data as { expensive: { expensiveRejected: boolean } }
    expect(d.expensive.expensiveRejected).toBe(true)
  })
  it('真改进候选获准晋级', () => {
    const d = results.sections[2]!.data as { good: { goodPromoted: boolean } }
    expect(d.good.goodPromoted).toBe(true)
  })
})

describe('E4 回归→自动回滚', () => {
  it('毒技能晋级后回归被检出，回滚删除文件且指标恢复', () => {
    const d = results.sections[3]!.data as {
      pass: boolean
      poisonWritten: boolean
      detected: boolean
      fileGone: boolean
      championPassRate: number
      recoveryPassRate: number
    }
    expect(d.poisonWritten).toBe(true)
    expect(d.detected, '回归未检出').toBe(true)
    expect(d.fileGone, '回滚未删除毒技能文件').toBe(true)
    expect(d.recoveryPassRate).toBeGreaterThanOrEqual(d.championPassRate - 0.15)
    expect(d.pass).toBe(true)
  })
})

describe('E5 防膨胀稳定性', () => {
  it('工单耗尽优雅停止，无重复签名技能', () => {
    const d = results.sections[4]!.data as { stable: boolean; exhausted: boolean; extraWithSignature: number }
    expect(d.exhausted).toBe(true)
    expect(d.extraWithSignature).toBe(0)
    expect(d.stable).toBe(true)
  })
})

describe('实验报告', () => {
  it('LAB_REPORT.md 已生成且五项全部通过', () => {
    const report = results.report
    expect(report).toContain('# dsh-darwin 模拟实验报告')
    expect(report).toContain('✅ 全部通过')
    expect(results.sections).toHaveLength(5)
  })
})
