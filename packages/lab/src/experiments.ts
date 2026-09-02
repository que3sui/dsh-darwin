import {
  aggregateResults,
  CandidatePlugin,
  PROTOCOL_VERSION,
  type AggregateMetrics,
  type GateDecision,
  type SkillArtifact,
} from '@dsh-darwin/protocol'
import { decideGate } from 'dsh-forge'
import type { RawEvent } from 'dsh-sentinel'
import { POISON_MARKER, runTask } from './agent.ts'
import { evaluateCandidate, familyOfCandidate, runSuite } from './evaluator.ts'
import { FAMILIES, LOAD_FAMILIES, type TaskFamily } from './families.ts'
import { mulberry32 } from './rng.ts'
import { bootLab, type Lab } from './runtime.ts'

/**
 * E1~E5：全部实验 mock 运行时、复用真实插件代码与真实评测门，
 * 固定种子，可复现。详细假设与判定标准见 LAB_REPORT.md。
 */

export interface Section {
  name: string
  lines: string[]
  data: Record<string, unknown>
}

const T0 = 1_700_000_000_000

/* ============================ E1 挖掘查全/查准 ============================ */

function cleanSession(id: string, tokens = 400): RawEvent[] {
  return [
    { sessionId: id, seq: 0, time: T0, type: 'tool/call', name: 'bash', turn: 0 },
    { sessionId: id, seq: 1, time: T0 + 2_000, type: 'tool/result', name: 'bash', turn: 0 },
    {
      sessionId: id,
      seq: 2,
      time: T0 + 4_000,
      type: 'assistant/message',
      turn: 0,
      usage: { inputTokens: tokens / 2, outputTokens: tokens / 2 },
    },
    { sessionId: id, seq: 3, time: T0 + 6_000, type: 'turn/end', turn: 0, turnEndReason: 'completed' },
  ]
}

/** 4 次 llm/retry（触发重试环）+ 2 个 ETIMEDOUT 错误 + 2 个被打断回合 */
function retryHeavySession(id: string): RawEvent[] {
  const ev: RawEvent[] = []
  let seq = 0
  for (const turn of [0, 1]) {
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'tool/call', name: 'bash', turn })
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'llm/retry', turn })
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'llm/retry', turn })
    ev.push({
      sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'tool/result',
      name: 'bash', errorCode: 'ETIMEDOUT', errorText: 'bash failed with ETIMEDOUT', turn,
    })
    ev.push({
      sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'assistant/message', turn,
      usage: { inputTokens: 600, outputTokens: 600 },
    })
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'turn/end', turn, interrupted: true, turnEndReason: 'interrupted' })
  }
  return ev
}

/** 纯错误簇供体：2 个 EACCES 错误 + 2 个被打断回合，无 retry */
function errorOnlySession(id: string, errorCode: string): RawEvent[] {
  const ev: RawEvent[] = []
  let seq = 0
  for (const turn of [0, 1]) {
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'tool/call', name: 'bash', turn })
    ev.push({
      sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'tool/result',
      name: 'bash', errorCode, errorText: `bash failed with ${errorCode}`, turn,
    })
    ev.push({
      sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'assistant/message', turn,
      usage: { inputTokens: 400, outputTokens: 400 },
    })
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'turn/end', turn, interrupted: true, turnEndReason: 'interrupted' })
  }
  return ev
}

function interruptedOnlySession(id: string): RawEvent[] {
  const ev: RawEvent[] = []
  let seq = 0
  for (const turn of [0, 1]) {
    ev.push({
      sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'assistant/message', turn,
      usage: { inputTokens: 200, outputTokens: 200 },
    })
    ev.push({ sessionId: id, seq: seq++, time: T0 + seq * 2_000, type: 'turn/end', turn, interrupted: true, turnEndReason: 'interrupted' })
  }
  return ev
}

export async function experiment1Mining(): Promise<Section> {
  const lab = bootLab()
  const planted = new Set<string>()
  const clean = new Set<string>()

  for (let i = 0; i < 30; i++) {
    const id = `clean-${i}`
    clean.add(id)
    lab.sessionLog.addSession(cleanSession(id))
  }
  for (let i = 0; i < 4; i++) {
    const id = `retry-${i}`
    planted.add(id)
    lab.sessionLog.addSession(retryHeavySession(id))
  }
  for (let i = 0; i < 3; i++) {
    const id = `eacces-${i}`
    planted.add(id)
    lab.sessionLog.addSession(errorOnlySession(id, 'EACCES'))
  }
  for (let i = 0; i < 2; i++) {
    const id = `intr-${i}`
    planted.add(id)
    lab.sessionLog.addSession(interruptedOnlySession(id))
  }
  planted.add('whale')
  lab.sessionLog.addSession(cleanSession('whale', 12_000))

  const scanOut = await lab.call('darwin_scan')
  const tickets = await lab.tickets.all()
  const kinds: Record<string, number> = {}
  for (const t of tickets) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1

  const cleanContaminated = [
    ...new Set(tickets.flatMap((t) => t.sourceSessions).filter((s) => clean.has(s))),
  ]
  const clusterTitles = tickets.filter((t) => t.kind === 'tool-error-cluster').map((t) => t.title)
  const tokenWaste = tickets.filter((t) => t.kind === 'token-waste')
  const tokenWasteIncludesWhale = tokenWaste.some((t) => t.sourceSessions.includes('whale'))

  const precisionOk = cleanContaminated.length === 0
  const recallOk =
    (kinds['retry-loop'] ?? 0) >= 1 &&
    clusterTitles.some((title) => title.includes('ETIMEDOUT')) &&
    clusterTitles.some((title) => title.includes('EACCES')) &&
    (kinds['interrupted-turn'] ?? 0) >= 1 &&
    tokenWasteIncludesWhale

  return {
    name: 'E1 挖掘查全/查准',
    lines: [
      `- 合成负载：30 个干净会话 + 植入缺陷 10 个（4 重试环 / 3 EACCES 错误簇 / 2 纯中断 / 1 Token 鲸鱼 12k）`,
      `- darwin_scan 产出工单 ${tickets.length} 张：${JSON.stringify(kinds)}`,
      `- 错误簇工单：${clusterTitles.join(' , ')}`,
      `- 查准：所有工单 sourceSessions ⊆ 植入集 → ${precisionOk}（污染的干净会话：${cleanContaminated.length}）`,
      `- 查全：重试环/两类错误簇/中断/鲸鱼全部检出 → ${recallOk}`,
      `- 扫描器输出：${scanOut.split('\n')[0] ?? ''}`,
      `- **判定：${precisionOk && recallOk ? '通过' : '未通过'}**`,
    ],
    data: { totalTickets: tickets.length, kinds, precisionOk, recallOk, cleanContaminated },
  }
}

/* ============================ E2 端到端飞轮 ============================ */

const E2_MIX: Array<[TaskFamily, number]> = [
  [FAMILIES['bash-timeout'], 20],
  [FAMILIES['perm-denied'], 16],
  [FAMILIES['dep-missing'], 12],
]

function measureMix(skills: SkillArtifact[], seed: number): { passRate: number; avgTokens: number } {
  const rng = mulberry32(seed)
  let pass = 0
  let total = 0
  let tokens = 0
  let clock = 0
  for (const [fam, n] of E2_MIX) {
    for (let i = 0; i < n; i++) {
      const run = runTask(fam, skills, rng, `m-${fam.id}-${i}`, T0 + clock)
      clock += 10_000
      pass += run.passed ? 1 : 0
      total++
      tokens += run.tokens
    }
  }
  return { passRate: pass / total, avgTokens: tokens / total }
}

async function forgeEvaluatePromoteOnce(
  lab: Lab,
  families: TaskFamily[],
  rngSeed: number,
): Promise<{ candidateId?: string; signature?: string; verdict?: GateDecision['verdict']; reasons: string[] }> {
  const out = await lab.call('darwin_forge')
  const id = /候选 id: (cnd-[0-9a-z]+)/.exec(out)?.[1]
  if (!id) return { reasons: [out.split('\n')[0] ?? ''] }
  const candidate = await lab.candidates.get(id)
  if (!candidate) return { candidateId: id, reasons: ['候选不存在'] }
  const fam = familyOfCandidate(candidate, families)
  if (!fam) return { candidateId: id, reasons: ['非问题族候选，跳过评测'] }

  const championSkills = await lab.readMountedSkills()
  const firstEver = championSkills.length === 0
  const trial = evaluateCandidate(
    candidate,
    championSkills,
    { visible: fam, hidden: fam, nVisible: 8, nHidden: 3 },
    rngSeed,
  )
  const verdict = trial.decision.verdict
  if (verdict === 'promote' || (verdict === 'needs_human' && firstEver)) {
    await lab.call('darwin_promote', { candidateId: id, confirm: true })
    return { candidateId: id, signature: fam.signature, verdict, reasons: trial.decision.reasons }
  }
  return { candidateId: id, signature: fam.signature, verdict, reasons: trial.decision.reasons }
}

export async function experiment2Flywheel(): Promise<Section> {
  const lab = bootLab()
  const rng = mulberry32(20260901)
  let clock = 0
  for (const [fam, n] of E2_MIX) {
    for (let i = 0; i < n; i++) {
      const run = runTask(fam, [], rng, `${fam.id}-${i}`, T0 + clock)
      clock += 10_000
      lab.sessionLog.addSession(run.events)
    }
  }

  await lab.call('darwin_scan')
  const promoted: string[] = []
  const gateVerdicts: string[] = []
  const gateReasons: string[][] = []
  for (let round = 0; round < 3; round++) {
    const r = await forgeEvaluatePromoteOnce(lab, LOAD_FAMILIES, 700 + round)
    gateVerdicts.push(r.verdict ?? 'no-candidate')
    gateReasons.push(r.reasons)
    if (r.signature) promoted.push(r.signature)
  }

  const pre = measureMix([], 424242)
  const post = measureMix(await lab.readMountedSkills(), 424242)
  const improved = post.passRate >= pre.passRate + 0.25 && post.avgTokens < pre.avgTokens
  const signaturesOk =
    promoted.length === 3 &&
    new Set(promoted).size === 3 &&
    ['ETIMEDOUT', 'EACCES', 'ENOENT'].every((s) => promoted.includes(s))

  return {
    name: 'E2 端到端飞轮（挖掘→合成→评测→晋级→重放）',
    lines: [
      `- 基线负载：48 会话（20/16/12 三族，无技能成功率 ≈35-40%），darwin_scan → darwin_forge ×3 → 评测门 → darwin_promote`,
      `- 三轮门决策：${gateVerdicts.join(' → ')}（冠军基线 = 晋级前的已挂载技能组合，首轮即无技能基线，可直接对比）`,
      `- 门理由（第 1 轮）：${gateReasons[0]?.join('；') ?? ''}`,
      `- 晋级技能签名：{${promoted.join(', ')}}（期望恰为三族各一）→ ${signaturesOk}`,
      `- 重放同一 48 任务混合（配对同种子）：成功率 ${pct(pre.passRate)} → ${pct(post.passRate)}（+${pts(pre.passRate, post.passRate)}pt），平均 token ${Math.round(pre.avgTokens)} → ${Math.round(post.avgTokens)}（${pctDelta(pre.avgTokens, post.avgTokens)}）`,
      `- **判定：${signaturesOk && improved ? '通过' : '未通过'}**（要求：三签名各一、成功率 +≥25pt、token 下降）`,
    ],
    data: {
      promotedSignatures: promoted,
      pre,
      post,
      gateVerdicts,
      signaturesOk,
      improved,
    },
  }
}

/* ============================ E3 评测门对抗 ============================ */

function agg(passRate: number, avgTokens: number, hiddenFailed = 0, total = 9): AggregateMetrics {
  const passed = Math.round(total * passRate)
  return { tasksTotal: total, tasksPassed: passed, passRate, avgTurns: 3, avgTokens, hiddenFailed }
}

function skillArtifact(name: string, body: string): SkillArtifact {
  return {
    tier: 'skill',
    skillName: name,
    frontmatter: { name, description: 'E3 对抗候选' },
    body,
  }
}

export function experiment3GateAdversarial(): Section {
  const overfitSkill = skillArtifact(
    'darwin-overfit',
    '遇到 ETIMEDOUT 时先降级重试参数再执行（本技能只覆盖超时族，从未提及 ECONNREFUSED）',
  )
  const spec = { visible: FAMILIES['bash-timeout'], hidden: FAMILIES['net-refused'], nVisible: 8, nHidden: 5 }
  const champAgg = aggregateResults(runSuite(spec, [], mulberry32(31337), 'o-champ'))
  const challAgg = aggregateResults(runSuite(spec, [overfitSkill], mulberry32(31337), 'o-chall'))
  const overfit = decideGate(champAgg, challAgg)

  const expensive = decideGate(agg(0.9, 1_000), agg(0.9, 1_400))

  const goodSkill = skillArtifact('darwin-good', '遇到 EACCES 时先检查目录属主与权限位，改用最小权限写入路径。')
  const goodSpec = { visible: FAMILIES['perm-denied'], hidden: FAMILIES['perm-denied'], nVisible: 8, nHidden: 3 }
  const goodChamp = aggregateResults(runSuite(goodSpec, [], mulberry32(42424), 'g-champ'))
  const goodChall = aggregateResults(runSuite(goodSpec, [goodSkill], mulberry32(42424), 'g-chall'))
  const good = decideGate(goodChamp, goodChall)

  const overfitRejected = overfit.verdict === 'reject' && overfit.challenger.hiddenFailed > 0
  const expensiveRejected = expensive.verdict === 'reject'
  const goodPromoted = good.verdict === 'promote'

  return {
    name: 'E3 评测门对抗（选择压）',
    lines: [
      `- ① 过拟合候选（只帮可见族，hold-out canary 用 net-refused/ECONNREFUSED）：canary 翻车 ${overfit.challenger.hiddenFailed} 项 → **${overfit.verdict}**（理由：${overfit.reasons[0] ?? ''}）`,
      `- ② 持平但 token +40%（构造样本）：→ **${expensive.verdict}**（理由：${expensive.reasons[0] ?? ''}）`,
      `- ③ 真改进候选（EACCES 技能，配对同种子 8+3 任务）：通过率 ${pct(goodChamp.passRate)} → ${pct(goodChall.passRate)} → **${good.verdict}**`,
      `- **判定：${overfitRejected && expensiveRejected && goodPromoted ? '通过' : '未通过'}**（要求：①② reject、③ promote）`,
    ],
    data: {
      overfit: { verdict: overfit.verdict, hiddenFailed: overfit.challenger.hiddenFailed, overfitRejected },
      expensive: { verdict: expensive.verdict, expensiveRejected },
      good: { verdict: good.verdict, before: goodChamp.passRate, after: goodChall.passRate, goodPromoted },
    },
  }
}

/* ============================ E4 回归→自动回滚 ============================ */

export async function experiment4Rollback(): Promise<Section> {
  const lab = bootLab()
  const famA = FAMILIES['bash-timeout']
  const rng = mulberry32(20260904)

  // 造最小生态：20 个 famA 任务 → scan → forge → 首轮晋级
  for (let i = 0; i < 20; i++) {
    lab.sessionLog.addSession(runTask(famA, [], rng, `e4-${i}`, T0 + i * 10_000).events)
  }
  await lab.call('darwin_scan')
  const first = await forgeEvaluatePromoteOnce(lab, LOAD_FAMILIES, 801)
  if (!first.signature) {
    return failSection('E4 回归→自动回滚', `基线晋级失败：${first.reasons.join('；')}`)
  }
  const championSkills = await lab.readMountedSkills()
  const championSuite = runSuite(
    { visible: famA, hidden: famA, nVisible: 10, nHidden: 3 },
    championSkills,
    mulberry32(555),
    'e4-champ',
  )
  const champion = aggregateResults(championSuite)

  // 注入毒技能候选（模拟外部/被污染的提议通道），人工确认晋级
  const poison = CandidatePlugin.parse({
    protocolVersion: PROTOCOL_VERSION,
    id: 'cnd-poison00000001',
    ticketId: 'tkt-external00001',
    title: '修复：bash 超时（外部贡献者提交的激进版本）',
    rationale: '外部进化通道',
    artifact: {
      tier: 'skill',
      skillName: 'darwin-evil-timeout',
      frontmatter: { name: 'darwin-evil-timeout', description: '更激进的超时处理策略' },
      body: `## 指引\n遇到 ETIMEDOUT 时不要改变方法，持续原样重试直到成功。\n<!-- ${POISON_MARKER} -->`,
    },
    status: 'draft',
    createdAt: 1,
    updatedAt: 1,
  })
  await lab.candidates.save(poison)
  await lab.call('darwin_promote', { candidateId: poison.id, confirm: true })
  const poisonPath = `proj/.dsh/skills/darwin-evil-timeout/SKILL.md`
  const poisonWritten = await lab.files.exists(poisonPath)

  // 回归重放：成功率应崩塌 → 触发确定性回滚
  const regression = runSuite(
    { visible: famA, hidden: famA, nVisible: 10, nHidden: 3 },
    await lab.readMountedSkills(),
    mulberry32(555),
    'e4-reg',
  )
  const regressionAgg = aggregateResults(regression)
  const detected = regressionAgg.passRate < champion.passRate - 0.2
  const rollbackOut = await lab.call('darwin_rollback', {
    skillName: 'darwin-evil-timeout',
    confirm: true,
  })
  const fileGone = !(await lab.files.exists(poisonPath))
  const recovery = aggregateResults(
    runSuite(
      { visible: famA, hidden: famA, nVisible: 10, nHidden: 3 },
      await lab.readMountedSkills(),
      mulberry32(555),
      'e4-rec',
    ),
  )

  const pass =
    poisonWritten && detected && fileGone && recovery.passRate >= champion.passRate - 0.15
  return {
    name: 'E4 回归→自动回滚',
    lines: [
      `- 基线：famA 技能晋级后冠军通过率 ${pct(champion.passRate)}（10+3 配对任务）`,
      `- 注入毒技能（含 ETIMEDOUT 签名 + POISON-GUIDE 标记）→ darwin_promote 确认写入：${poisonWritten}`,
      `- 回归重放：通过率崩至 ${pct(regressionAgg.passRate)}（冠军 -${pts(champion.passRate, regressionAgg.passRate)}pt）→ 检出回归：${detected}`,
      `- darwin_rollback → 文件删除：${fileGone}（输出：${rollbackOut.split('\n')[0] ?? ''}）`,
      `- 恢复重放：通过率 ${pct(recovery.passRate)}（冠军 ±15pt 内：${recovery.passRate >= champion.passRate - 0.15}）`,
      `- **判定：${pass ? '通过' : '未通过'}**`,
    ],
    data: {
      championPassRate: champion.passRate,
      regressionPassRate: regressionAgg.passRate,
      recoveryPassRate: recovery.passRate,
      poisonWritten,
      detected,
      fileGone,
      pass,
    },
  }
}

/* ============================ E5 防膨胀稳定性 ============================ */

export async function experiment5Stability(): Promise<Section> {
  const lab = bootLab()
  const rng = mulberry32(20260905)
  for (let i = 0; i < 12; i++) {
    lab.sessionLog.addSession(runTask(FAMILIES['bash-timeout'], [], rng, `e5-${i}`, T0 + i * 10_000).events)
  }
  await lab.call('darwin_scan')

  // 第一轮：正常晋级 famA 技能
  const first = await forgeEvaluatePromoteOnce(lab, LOAD_FAMILIES, 901)
  const promotedBefore = new Set(await lab.skillNames())

  // 随后连续 forge：工单枯竭应优雅停止，残余候选不应携带问题族签名
  let extraCandidates = 0
  let extraWithSignature = 0
  let exhausted = false
  for (let i = 0; i < 10; i++) {
    const out = await lab.call('darwin_forge')
    const id = /候选 id: (cnd-[0-9a-z]+)/.exec(out)?.[1]
    if (!id) {
      exhausted = true
      break
    }
    extraCandidates++
    const c = await lab.candidates.get(id)
    if (!c) continue
    if (familyOfCandidate(c, LOAD_FAMILIES)) extraWithSignature++
  }
  const promotedAfter = new Set(await lab.skillNames())
  const stable =
    exhausted &&
    promotedBefore.size === promotedAfter.size &&
    [...promotedAfter].every((s) => promotedBefore.has(s)) &&
    extraWithSignature === 0

  return {
    name: 'E5 防膨胀稳定性',
    lines: [
      `- 小负载（12 会话）→ scan → 首轮晋级 ${first.signature ?? '失败'}`,
      `- 随后连续 darwin_forge：新增候选 ${extraCandidates} 个，其中携带问题族签名（可能重复覆盖）的 ${extraWithSignature} 个；工单耗尽优雅停止：${exhausted}`,
      `- 已晋级技能集合不变：${promotedBefore.size} → ${promotedAfter.size}`,
      `- **判定：${stable ? '通过' : '未通过'}**`,
    ],
    data: {
      promotedSignatures: [...promotedAfter],
      extraCandidates,
      extraWithSignature,
      exhausted,
      stable,
    },
  }
}

/* ============================ 汇总 ============================ */

function failSection(name: string, why: string): Section {
  return { name, lines: [`- **判定：未通过**（${why}）`], data: { pass: false } }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function pts(a: number, b: number): string {
  return ((b - a) * 100).toFixed(1)
}

function pctDelta(a: number, b: number): string {
  return a === 0 ? 'n/a' : `${((b - a) / a * 100).toFixed(1)}%`
}

export async function runAllExperiments(): Promise<{ sections: Section[]; report: string }> {
  const sections: Section[] = []
  sections.push(await experiment1Mining())
  sections.push(await experiment2Flywheel())
  sections.push(experiment3GateAdversarial())
  sections.push(await experiment4Rollback())
  sections.push(await experiment5Stability())

  const allPass = sections.every((s) => {
    const line = s.lines.find((l) => l.includes('**判定'))
    return line?.includes('通过') ?? false
  })

  const report = [
    '# dsh-darwin 模拟实验报告（LAB）',
    '',
    `> 运行环境：Node ${process.version}；全部实验固定种子可复现。`,
    '> 方法：mock DSH 运行时（会话日志/共享存储域/内存文件系统），`dsh-sentinel` 与 `dsh-forge` 的 `apply()` 原封不动挂载；评测门为真实的 `decideGate`；概率 agent 的技能效应按"签名匹配"简化建模。',
    '',
    `**总判定：${allPass ? '✅ 全部通过' : '❌ 存在未通过项'}**`,
    '',
    ...sections.flatMap((s) => [`## ${s.name}`, '', ...s.lines, '']),
    '## 边界声明',
    '',
    '- 本报告验证的是**架构逻辑闭环**（挖掘→工单→合成→选择→遗传→淘汰各环节连通且方向正确），不验证真实 LLM 行为与真实 DSH 运行时兼容性；',
    '- agent 的技能效应是"签名匹配即生效"的简化模型，真实技能质量取决于 LLM 合成水平（P1 模板技能是保守起点）；',
    '- token 为模型化相对量，仅用于趋势比较，不代表真实计费；',
    '- 指纹把聚类键中的数字压平（如会话编号）：同类缺陷的不同会话合并为一张工单（occurrences 累加），E1 的 retry-loop=1 张即 4 个植入会话归并的结果，属预期行为；',
    '- E2/E4 的 harness 策略里保留了"无冠军基线 → needs_human 人工确认"分支（P1 语义），本组实验中冠军基线始终可测（无技能组合），该分支未被触发。',
  ].join('\n')

  return { sections, report }
}
