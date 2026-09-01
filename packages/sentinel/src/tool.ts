import type { ScanSummary } from './scan'
import { renderTicketReport } from './report'
import type { TicketStore } from './store'

/**
 * 模型可调用的工具（定义形状与官方 defineTool 产物对齐的最小切面）。
 * 若运行环境可解析 @deepseek-ai/dsh-tools，可换成 defineTool() 以获得
 * schema 校验增强；纯对象在 ctx.tools.register 下同样可用（见 cookbook）。
 */
export interface DarwinToolDef {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: boolean; description: string }>
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
      parameters: {},
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
        top: { type: 'number', description: '最多展示条数，默认 10' },
      },
      execute: async (args) => {
        const store = await deps.store()
        const tickets = await store.all()
        const top = typeof args.top === 'number' && args.top > 0 ? Math.floor(args.top) : 10
        return renderTicketReport(tickets, top)
      },
    },
  ]
}
