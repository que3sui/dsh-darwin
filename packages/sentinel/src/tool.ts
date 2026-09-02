import type { ScanSummary } from './scan.ts'
import { renderTicketReport } from './report.ts'
import type { TicketStore } from './store.ts'

/**
 * 模型可调用的工具。
 * VERIFIED 0.1.1-rc.2（实机）：ctx.tools.register 强制 output = { schema, render, presentationMeta? }；
 * parameters 必须是编译后的完整 JSON Schema（defineTool 的产物形状：
 * { type: 'object', properties, required? }）——属性映射风格会被 API 拒绝
 * （schema must be of type "object", got 'type: null'）。
 */
export interface ToolParametersSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string }>
  required?: string[]
}

export interface ToolOutput {
  schema: Record<string, unknown>
  render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
}

const stringOutput: ToolOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export interface DarwinToolDef {
  name: string
  description: string
  parameters: ToolParametersSchema
  output: ToolOutput
  execute: (args: Record<string, unknown>) => Promise<string>
}

export function buildDarwinTools(deps: {
  scan: () => Promise<ScanSummary>
  store: () => PromiseLike<TicketStore>
}): DarwinToolDef[] {
  return [
    {
      name: 'darwin_scan',
      description:
        '扫描最近的 DSH 会话日志，机械化挖掘重试环/工具错误簇/中断回合/Token 浪费，并合并进问题工单库。',
      parameters: { type: 'object', properties: {} },
      output: stringOutput,
      execute: async () => {
        const s = await deps.scan()
        return [
          `扫描完成：${s.scannedSessions} 个会话，${s.signals} 个信号`,
          `新建工单 ${s.created}，更新 ${s.updated}`,
          s.topTitle ? `当前最严重：[${s.topSeverity}] ${s.topTitle}` : '当前无开放工单',
        ].join('\n')
      },
    },
    {
      name: 'darwin_report',
      description: '读取当前问题工单库，按严重度输出会话体检报告。',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: '最多展示条数，默认 10' },
        },
      },
      output: stringOutput,
      execute: async (args) => {
        const store = await deps.store()
        const tickets = await store.all()
        const top = typeof args.top === 'number' && args.top > 0 ? Math.floor(args.top) : 10
        return renderTicketReport(tickets, top)
      },
    },
  ]
}
