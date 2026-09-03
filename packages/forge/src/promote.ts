import { SkillSnapshot, type CandidatePlugin, type SkillArtifact } from './protocol.ts'
import { joinPath } from './promote-path.ts'

/**
 * 晋级（skill 级，P1）：
 * 写 <skillsRoot>/<skillName>/SKILL.md —— 官方分层注册表的项目级根
 * （docs/subsystems/skills.md：rank 100 的 <projectRoot>/.dsh/skills），
 * chokidar 热重载即时生效，无需重启。
 * 晋级前必留版本快照（回滚依据），requireConfirm 默认 true。
 */

export interface FilePort {
  read(path: string): Promise<string | undefined>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

/** 测试用内存文件系统 */
export class MemoryFilePort implements FilePort {
  private files = new Map<string, string>()
  async read(path: string): Promise<string | undefined> {
    return this.files.get(path)
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  list(prefix = ''): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix))
  }
}

export function renderSkillFile(artifact: SkillArtifact): string {
  const fm = [
    '---',
    `name: ${artifact.frontmatter.name}`,
    `description: ${artifact.frontmatter.description}`,
  ]
  if (artifact.frontmatter.whenToUse) fm.push(`whenToUse: ${artifact.frontmatter.whenToUse}`)
  fm.push('---', '')
  return [...fm, artifact.body].join('\n')
}

export type PromoteOutcome =
  | { status: 'promoted'; path: string; snapshot: SkillSnapshot }
  | { status: 'needs_human'; path: string }

export interface PromoteOptions {
  /** 默认 <projectRoot>/.dsh/skills（官方 rank-100 层，项目级隔离） */
  skillsRoot: string
  files: FilePort
  requireConfirm: boolean
  confirm?: boolean
  now?: number
}

export async function promoteSkill(
  candidate: CandidatePlugin,
  opts: PromoteOptions,
): Promise<PromoteOutcome> {
  if (candidate.artifact.tier !== 'skill') {
    throw new Error(`[dsh-darwin-forge] promoteSkill 只接受 skill 级候选，收到 "${candidate.artifact.tier}"`)
  }
  const artifact: SkillArtifact = candidate.artifact
  const path = joinPath(opts.skillsRoot, artifact.skillName, 'SKILL.md')
  const now = opts.now ?? Date.now()

  if (opts.requireConfirm && opts.confirm !== true) {
    return { status: 'needs_human', path }
  }

  const prev = (await opts.files.exists(path)) ? ((await opts.files.read(path)) ?? null) : null
  const snapshot: SkillSnapshot = SkillSnapshot.parse({
    skillName: artifact.skillName,
    content: prev,
    candidateId: candidate.id,
    savedAt: now,
  })

  await opts.files.write(path, renderSkillFile(artifact))
  return { status: 'promoted', path, snapshot }
}
