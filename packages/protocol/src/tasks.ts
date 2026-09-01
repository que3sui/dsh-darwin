import { z } from 'zod'
import type { AggregateMetrics, TaskResult } from './schema'

/**
 * 回归任务集 = forge 评测门的"选择压"来源。
 *
 * 防 reward hacking 的两条铁律（贯彻 ouroboros / 隐藏评分器经验）：
 * 1. `expect`（评分标准）物理上不进入任何 agent 上下文——下发任务只能走 redactForAgent；
 * 2. `hidden: true` 的 hold-out canary 不参与提案，只在晋级前重放，翻车一票否决。
 */

export const RegressionTask = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** hidden 任务不进提案上下文，仅用于晋级门 */
  hidden: z.boolean().default(false),
  expect: z
    .object({
      containsAll: z.array(z.string()).default([]),
      /** 正则 source 数组，命中任一即可 */
      matchesAny: z.array(z.string()).default([]),
      maxTurns: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .default({}),
})
export type RegressionTask = z.infer<typeof RegressionTask>

export const TaskSuite = z.object({
  id: z.string().min(1),
  tasks: z.array(RegressionTask).min(1),
  frozenAt: z.number().int().nonnegative(),
  note: z.string().max(1000).optional(),
})
export type TaskSuite = z.infer<typeof TaskSuite>

/** 评分器的唯一输入：可从会话日志导出的摘要，绝不含评分标准 */
export interface TranscriptSummary {
  finalText: string
  toolCalls: string[]
  turns: number
  tokens: number
}

export interface GradeOutcome {
  passed: boolean
  reasons: string[]
}

export function gradeTask(task: RegressionTask, transcript: TranscriptSummary): GradeOutcome {
  const reasons: string[] = []
  let passed = true

  // 语义：containsAll 与 matchesAny 同时非空时取 AND（两者都是硬性要求）
  for (const needle of task.expect.containsAll) {
    if (!transcript.finalText.includes(needle)) {
      passed = false
      reasons.push(`missing: "${needle}"`)
    }
  }
  if (task.expect.matchesAny.length > 0) {
    let matched = false
    for (const source of task.expect.matchesAny) {
      try {
        if (new RegExp(source).test(transcript.finalText)) {
          matched = true
          break
        }
      } catch {
        passed = false
        reasons.push(`invalid regex: /${source}/`)
        matched = true // 已按失败计，不再重复报 no match
        break
      }
    }
    if (!matched) {
      passed = false
      reasons.push(`no match in [${task.expect.matchesAny.map((s) => `/${s}/`).join(', ')}]`)
    }
  }
  if (task.expect.maxTurns !== undefined && transcript.turns > task.expect.maxTurns) {
    passed = false
    reasons.push(`turns ${transcript.turns} > ${task.expect.maxTurns}`)
  }
  if (task.expect.maxTokens !== undefined && transcript.tokens > task.expect.maxTokens) {
    passed = false
    reasons.push(`tokens ${transcript.tokens} > ${task.expect.maxTokens}`)
  }
  return { passed, reasons }
}

/**
 * 把任务集下发给 agent（子代理/workflow）时的唯一合法出口：
 * 只暴露 id + prompt，expect 与 hidden 标记被物理剥离。
 */
export function redactForAgent(suite: TaskSuite): Array<{ id: string; prompt: string }> {
  return suite.tasks.map((t) => ({ id: t.id, prompt: t.prompt }))
}

export function aggregateResults(results: TaskResult[]): AggregateMetrics {
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  const hiddenFailed = results.filter((r) => r.hidden && !r.passed).length
  const avgTurns = total === 0 ? 0 : results.reduce((s, r) => s + r.turns, 0) / total
  const avgTokens = total === 0 ? 0 : results.reduce((s, r) => s + r.tokens, 0) / total
  return {
    tasksTotal: total,
    tasksPassed: passed,
    passRate: total === 0 ? 0 : passed / total,
    avgTurns,
    avgTokens,
    hiddenFailed,
  }
}
