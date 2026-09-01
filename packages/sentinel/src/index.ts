import { buildDarwinTools } from './tool'
import { scanOnce } from './scan'
import { wireSentinel, type SentinelContext } from './dsh-adapter'

/**
 * dsh-sentinel —— dsh-darwin 双插件自进化架构的信号源（B 面）。
 * 只读为主：机械挖掘会话日志 → 结构化 ProblemTicket 落入 storageDomain
 * 共享域 `darwin`，供 dsh-forge（插件工厂）消费。
 * 可独立安装：不装 forge 时，darwin_report/darwin_scan 就是会话体检工具。
 */

export const name = 'dsh-sentinel'

/** Cordis 依赖声明：fiber 在这些服务就绪前保持 PENDING */
export const inject = ['sessionQuery', 'storageDomain', 'tools'] as const

export interface SentinelConfig {
  /** P0 默认关闭（手动 darwin_scan 触发）；自动扫描需验证 session/event 订阅 API */
  autoScan: boolean
  lookbackSessions: number
}

export function apply(ctx: SentinelContext, config: Partial<SentinelConfig> = {}): void {
  const { query, store } = wireSentinel(ctx)
  const scan = () => scanOnce({ query, store, config })

  for (const tool of buildDarwinTools({ scan, store: async () => store })) {
    ctx.tools?.register?.(tool)
  }
  ctx.logger?.info?.('[dsh-sentinel] 已注册 darwin_scan / darwin_report')

  if (config.autoScan) {
    // TODO(P0.1)：订阅官方 'session/event' firehose，每 N turn 节流触发 scanOnce()。
    // 预览期事件订阅形状未定，暂不启用，避免坏一个上游版本拖垮整个插件。
    ctx.logger?.warn?.('[dsh-sentinel] autoScan 在 P0 尚未实现，请使用 darwin_scan 手动触发')
  }
}
