import type { SkillSnapshot } from './protocol.ts'
import type { FilePort } from './promote.ts'
import { joinPath } from './promote-path.ts'

/**
 * 确定性回滚：完全依据晋级时留下的 SkillSnapshot 恢复，
 * 不让 LLM 重新猜旧内容（对照 ZK-Andy 的 inverse-edit 原则）。
 * content 为 null 表示晋级前文件不存在 → 回滚即删除。
 */
export interface RollbackOptions {
  skillsRoot: string
  files: FilePort
}

export interface RollbackOutcome {
  restored: boolean
  path: string
  action: 'restored-content' | 'removed-file' | 'already-applied'
}

export async function rollbackSkill(
  skillName: string,
  snapshot: SkillSnapshot,
  opts: RollbackOptions,
): Promise<RollbackOutcome> {
  if (snapshot.skillName !== skillName) {
    throw new Error(`[dsh-forge] 快照与技能名不匹配：${snapshot.skillName} ≠ ${skillName}`)
  }
  const path = joinPath(opts.skillsRoot, skillName, 'SKILL.md')

  if (snapshot.content === null) {
    if (await opts.files.exists(path)) {
      await opts.files.remove(path)
      return { restored: true, path, action: 'removed-file' }
    }
    return { restored: true, path, action: 'already-applied' }
  }

  const current = await opts.files.read(path)
  if (current === snapshot.content) {
    return { restored: true, path, action: 'already-applied' }
  }
  await opts.files.write(path, snapshot.content)
  return { restored: true, path, action: 'restored-content' }
}
