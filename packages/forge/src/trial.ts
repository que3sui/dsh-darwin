import type { CandidatePlugin } from './protocol.ts'

/**
 * 试挂（P2）：借助官方 Creator 模式 Gen 2 工具集背后的
 * ctx.dynamicCordisRunner 做沙箱内挂载（cordis_define/run/stop/undefine）。
 * 官方承诺 undefine 会等所有副作用静止后才返回——这是自动卸载的安全底座。
 * 官方同时警告：vm 沙箱"隔离全局但不构成安全边界"。
 * 因此本层只在显式 opt-in code 级时可用，且调用方必须在外层套人工确认。
 */

export class TrialDisabledError extends Error {}

export interface TrialPort {
  define(req: { pluginId: string; code: string; idPrefix?: string }): Promise<{ packageId: string }>
  run(pluginId: string, packageId: string, mode: 'run' | 'update'): Promise<unknown>
  stop(pluginId: string): Promise<void>
  undefine(pluginId: string): Promise<void>
}

/**
 * TODO(verify 0.1.x)：官方 ctx.dynamicCordisRunner（packages/extensions/cordis-host-runner）：
 *   define(request: DynamicCordisDefineRequest): DynamicCordisDefineReceipt
 *   run(agent, pluginId, packageId, mode, signal?)
 *   stop(agent, pluginId) / undefine(agent, pluginId)
 * 预览期签名可能变化；wire 失败要响亮报错而不是静默跳过。
 */
export function wireTrial(ctx: { dynamicCordisRunner?: unknown }): TrialPort {
  const r = ctx.dynamicCordisRunner as
    | {
        define?: (req: unknown) => unknown
        run?: (...a: unknown[]) => Promise<unknown>
        stop?: (...a: unknown[]) => Promise<void>
        undefine?: (...a: unknown[]) => Promise<void>
      }
    | undefined
  if (!r || typeof r.define !== 'function') {
    throw new TrialDisabledError(
      '[dsh-forge] 找不到 ctx.dynamicCordisRunner：请在 profile 补丁显式挂载 cordis-host-runner（见官方 dynamic-cordis.md），且仅在你接受 bash 级信任时启用。',
    )
  }
  return {
    async define(req) {
      const receipt = r.define!(req) as { packageId?: string; id?: string } | undefined
      return { packageId: String(receipt?.packageId ?? receipt?.id ?? '') }
    },
    run: (pluginId, packageId, mode) => r.run!(undefined, pluginId, packageId, mode) as Promise<unknown>,
    stop: (pluginId) => r.stop!(undefined, pluginId) as Promise<void>,
    undefine: (pluginId) => r.undefine!(undefined, pluginId) as Promise<void>,
  }
}

/**
 * 沙箱试挂包装：define → run → 执行 fn → finally stop+undefine。
 * 只接受 code 级候选（skill/config 级不进 vm，走各自的低风险路径）。
 */
export async function withTrialMount<T>(
  port: TrialPort,
  candidate: CandidatePlugin,
  fn: () => Promise<T>,
): Promise<T> {
  if (candidate.artifact.tier !== 'code') {
    throw new TrialDisabledError(
      `[dsh-forge] 层级 "${candidate.artifact.tier}" 不需要 vm 试挂：skill 走文件热重载路径，config 永远人工处理`,
    )
  }
  const pluginId = candidate.artifact.pluginId
  const { packageId } = await port.define({
    pluginId,
    code: candidate.artifact.source,
    idPrefix: 'darwin',
  })
  try {
    await port.run(pluginId, packageId, 'run')
    return await fn()
  } finally {
    await port.stop(pluginId).catch(() => {})
    await port.undefine(pluginId).catch(() => {})
  }
}
