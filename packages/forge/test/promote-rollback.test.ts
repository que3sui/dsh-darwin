import { describe, expect, it } from 'vitest'
import { synthesizeCandidate, DEFAULT_SYNTH_CONFIG } from '../src/synthesizer'
import { promoteSkill, MemoryFilePort, renderSkillFile } from '../src/promote'
import { rollbackSkill } from '../src/rollback'
import type { CandidatePlugin, SkillArtifact } from '@dsh-darwin/protocol'

const NOW = 1_700_000_000_000
const ROOT = 'proj/.dsh/skills'

function skillCandidate(): CandidatePlugin {
  return synthesizeCandidate(
    {
      protocolVersion: '0.1.0',
      id: 'tkt-test000000000',
      kind: 'tool-error-cluster',
      title: '工具错误簇：bash:ETIMEDOUT',
      detail: '',
      severity: 50,
      fingerprint: 'aa11bb22cc33dd44',
      occurrences: 5,
      wastedTokensEstimate: 0,
      evidence: [],
      status: 'open',
      createdAt: NOW,
      updatedAt: NOW,
      lastSeenAt: NOW,
      sourceSessions: [],
    },
    DEFAULT_SYNTH_CONFIG,
    NOW,
  )
}

function artifactOf(c: CandidatePlugin): SkillArtifact {
  if (c.artifact.tier !== 'skill') throw new Error('expected skill artifact')
  return c.artifact
}

describe('晋级（P1 skill 级）', () => {
  it('requireConfirm 开启且未 confirm → needs_human 且不写文件', async () => {
    const files = new MemoryFilePort()
    const c = skillCandidate()
    const out = await promoteSkill(c, { skillsRoot: ROOT, files, requireConfirm: true })
    expect(out.status).toBe('needs_human')
    const a = artifactOf(c)
    expect(await files.exists(`${ROOT}/${a.skillName}/SKILL.md`)).toBe(false)
  })

  it('confirm 后写入 SKILL.md，快照记录"此前不存在"', async () => {
    const files = new MemoryFilePort()
    const c = skillCandidate()
    const out = await promoteSkill(c, { skillsRoot: ROOT, files, requireConfirm: true, confirm: true, now: NOW })
    expect(out.status).toBe('promoted')
    if (out.status !== 'promoted') return
    const a = artifactOf(c)
    expect(out.snapshot.content).toBeNull()
    expect(out.snapshot.skillName).toBe(a.skillName)
    const written = await files.read(`${ROOT}/${a.skillName}/SKILL.md`)
    expect(written).toBe(renderSkillFile(a))
    expect(written).toContain('---')
    expect(written).toContain(`name: ${a.skillName}`)
  })

  it('覆盖旧版本时快照保存旧内容', async () => {
    const files = new MemoryFilePort()
    const a = artifactOf(skillCandidate())
    const path = `${ROOT}/${a.skillName}/SKILL.md`
    await files.write(path, '旧版本内容')

    const out = await promoteSkill(skillCandidate(), {
      skillsRoot: ROOT, files, requireConfirm: false, now: NOW,
    })
    expect(out.status).toBe('promoted')
    if (out.status !== 'promoted') return
    expect(out.snapshot.content).toBe('旧版本内容')
  })

  it('非 skill 级候选直接拒绝', async () => {
    const c = skillCandidate()
    const configCandidate: CandidatePlugin = {
      ...c,
      id: 'cnd-config0000000',
      artifact: { tier: 'config', patchRows: [{ id: 'x', disabled: true }], note: '' },
    }
    await expect(
      promoteSkill(configCandidate, { skillsRoot: ROOT, files: new MemoryFilePort(), requireConfirm: false }),
    ).rejects.toThrow('skill')
  })
})

describe('回滚（确定性恢复）', () => {
  it('晋级前不存在 → 回滚删除文件；重复回滚幂等', async () => {
    const files = new MemoryFilePort()
    const c = skillCandidate()
    const promoted = await promoteSkill(c, { skillsRoot: ROOT, files, requireConfirm: false, now: NOW })
    if (promoted.status !== 'promoted') throw new Error('expected promoted')
    const name = promoted.snapshot.skillName

    const first = await rollbackSkill(name, promoted.snapshot, { skillsRoot: ROOT, files })
    expect(first.action).toBe('removed-file')
    expect(await files.exists(`${ROOT}/${name}/SKILL.md`)).toBe(false)

    const second = await rollbackSkill(name, promoted.snapshot, { skillsRoot: ROOT, files })
    expect(second.action).toBe('already-applied')
  })

  it('晋级前存在旧版 → 回滚精确还原旧内容；重复回滚幂等', async () => {
    const files = new MemoryFilePort()
    const a = artifactOf(skillCandidate())
    const path = `${ROOT}/${a.skillName}/SKILL.md`
    await files.write(path, '旧版本内容')

    const promoted = await promoteSkill(skillCandidate(), {
      skillsRoot: ROOT, files, requireConfirm: false, now: NOW,
    })
    if (promoted.status !== 'promoted') throw new Error('expected promoted')

    const first = await rollbackSkill(a.skillName, promoted.snapshot, { skillsRoot: ROOT, files })
    expect(first.action).toBe('restored-content')
    expect(await files.read(path)).toBe('旧版本内容')

    const second = await rollbackSkill(a.skillName, promoted.snapshot, { skillsRoot: ROOT, files })
    expect(second.action).toBe('already-applied')
  })

  it('快照与技能名不匹配 → 响亮报错', async () => {
    const files = new MemoryFilePort()
    const promoted = await promoteSkill(skillCandidate(), {
      skillsRoot: ROOT, files, requireConfirm: false, now: NOW,
    })
    if (promoted.status !== 'promoted') throw new Error('expected promoted')
    await expect(
      rollbackSkill('another-skill', promoted.snapshot, { skillsRoot: ROOT, files }),
    ).rejects.toThrow('不匹配')
  })
})
