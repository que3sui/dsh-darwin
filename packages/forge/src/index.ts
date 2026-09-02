import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { Tier } from './protocol.ts'
import { wireForge, type ForgeContext, type ForgeServices } from './dsh-adapter.ts'
import { buildForgeTools, type ForgeDeps, type ForgeHooks } from './tool.ts'
import { promoteSkill, type FilePort } from './promote.ts'
import { rollbackSkill as doRollback } from './rollback.ts'
import { DEFAULT_SYNTH_CONFIG } from './synthesizer.ts'

/**
 * dsh-forge —— dsh-darwin 双插件自进化架构的插件工厂（A 面）。
 * 消费 dsh-sentinel 的问题工单 → 分级合成候选（MVP：skill/config，零代码执行）
 * → 人工确认晋级为 .dsh/skills 技能（热重载）→ 留快照供确定性回滚。
 * P2 接 cordis 试挂 + fork A/B 评测门；P3 才考虑 code 级合成（默认禁用）。
 */

export const name = 'dsh-forge'

export const inject = ['storageDomain', 'tools'] as const

export type { ForgeContext, ForgeServices } from './dsh-adapter.ts'
export { MemoryFilePort, type FilePort } from './promote.ts'
export { decideGate, DEFAULT_GATE_POLICY, type GatePolicy } from './gate.ts'
export {
  DomainCandidateStore,
  MemoryCandidateStore,
  type CandidateStore,
  type SnapshotStore,
} from './store.ts'

export interface ForgeConfig {
  enabledTiers: Tier[]
  requireConfirm: boolean
  /** 缺省 <projectRoot>/.dsh/skills；当前用相对路径，由 DSH 的工作目录决定 */
  skillsRoot: string
  /** 文件系统注入点（lab 模拟注入内存实现；缺省 Node 文件系统） */
  files?: FilePort
}

export async function apply(ctx: ForgeContext, config: Partial<ForgeConfig> = {}): Promise<void> {
  const services: ForgeServices = await wireForge(ctx)
  const deps: ForgeDeps = {
    services,
    synth: {
      enabledTiers: config.enabledTiers ?? DEFAULT_SYNTH_CONFIG.enabledTiers,
    },
    skillsRoot: config.skillsRoot ?? './.dsh/skills',
    requireConfirm: config.requireConfirm ?? true,
  }

  const files: FilePort = config.files ?? new NodeFilePort()

  const hooks: ForgeHooks = {
    async promoteSkill(candidateId, confirm, now) {
      const candidate = await services.candidates.get(candidateId)
      if (!candidate) return `找不到候选 ${candidateId}`
      const outcome = await promoteSkill(candidate, {
        skillsRoot: deps.skillsRoot,
        files,
        requireConfirm: deps.requireConfirm,
        confirm,
        now,
      })
      if (outcome.status === 'needs_human') {
        return `需要人工确认：将把候选写入 ${outcome.path}。确认无误后用 confirm=true 重试。`
      }
      await services.snapshots.save(outcome.snapshot)
      await services.candidates.save({ ...candidate, status: 'promoted', updatedAt: now })
      await services.lineage.save({
        id: `lin-promote-${candidate.id}-${now}`,
        kind: 'promotion',
        at: now,
        refs: { candidateId: candidate.id, ticketId: candidate.ticketId },
        note: `promoted → ${outcome.path}`,
      })
      const skillName =
        candidate.artifact.tier === 'skill' ? candidate.artifact.skillName : candidate.id
      return [
        `已晋级 → ${outcome.path}（官方热重载即时生效）`,
        `已留快照，回滚：darwin_rollback { skillName: "${skillName}", confirm: true }`,
      ].join('\n')
    },

    async rollbackSkill(skillName, confirm, now) {
      if (deps.requireConfirm && !confirm) {
        return `回滚会覆盖当前技能文件，确认后用 confirm=true 重试（skillName=${skillName}）`
      }
      const snapshot = await services.snapshots.latest(skillName)
      if (!snapshot) return `没有找到 ${skillName} 的晋级快照，无从回滚`
      const result = await doRollback(skillName, snapshot, { skillsRoot: deps.skillsRoot, files })
      await services.lineage.save({
        id: `lin-rollback-${skillName}-${now}`,
        kind: 'rollback',
        at: now,
        refs: { candidateId: snapshot.candidateId },
        note: `rollback ${result.action} → ${result.path}`,
      })
      const candidate = await services.candidates.get(snapshot.candidateId)
      if (candidate) {
        await services.candidates.save({ ...candidate, status: 'rolled_back', updatedAt: now })
      }
      return `已回滚（${result.action}）→ ${result.path}`
    },
  }

  for (const tool of buildForgeTools(deps, hooks)) {
    ctx.tools?.register?.(tool)
  }
  ctx.logger?.info?.('[dsh-forge] 已注册 darwin_forge / darwin_promote / darwin_rollback')
}

class NodeFilePort implements FilePort {
  async read(path: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path, 'utf8')
    } catch {
      return undefined
    }
  }
  async write(path: string, content: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, content, 'utf8')
  }
  async remove(path: string): Promise<void> {
    await fs.rm(path, { force: true })
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  }
}
