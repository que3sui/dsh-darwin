import type { AggregateMetrics, GateDecision } from '@dsh-darwin/protocol'

/**
 * 评测门 = 双插件架构里缺失的那块"选择压"。
 * 全部为纯函数，规则可单测；任何一条红线不过 → reject，拿不准 → needs_human。
 */

export interface GatePolicy {
  /** 挑战者最低通过率 */
  minPassRate: number
  /** 挑战者平均 token 相对冠军的最大容忍涨幅（无质量收益时） */
  maxCostRatio: number
  /** 与冠军持平时是否允许直接晋级（默认否 → needs_human） */
  allowTiePromotion: boolean
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  minPassRate: 0.8,
  maxCostRatio: 0.2,
  allowTiePromotion: false,
}

export function decideGate(
  champion: AggregateMetrics | undefined,
  challenger: AggregateMetrics,
  policy: GatePolicy = DEFAULT_GATE_POLICY,
): GateDecision {
  const reasons: string[] = []

  if (challenger.tasksTotal === 0) {
    return {
      verdict: 'needs_human',
      reasons: ['评测样本为空：无法判定，请检查任务集与 workflow 运行器'],
      champion,
      challenger,
    }
  }

  // 红线 1：hold-out canary 一票否决（防 reward hacking 的最后防线）
  if (challenger.hiddenFailed > 0) {
    return {
      verdict: 'reject',
      reasons: [`hidden canary 翻车 ${challenger.hiddenFailed} 项：疑似迎合可见任务，拒绝晋级`],
      champion,
      challenger,
    }
  }

  // 红线 2：绝对通过率下限
  if (challenger.passRate < policy.minPassRate) {
    return {
      verdict: 'reject',
      reasons: [`通过率 ${(challenger.passRate * 100).toFixed(0)}% 低于下限 ${(policy.minPassRate * 100).toFixed(0)}%`],
      champion,
      challenger,
    }
  }

  // 无冠军基线（首次晋级）：人工把关
  if (!champion) {
    return {
      verdict: 'needs_human',
      reasons: ['无冠军基线可比对：首次晋级需人工确认'],
      champion,
      challenger,
    }
  }

  // 红线 3：不能比冠军差
  if (challenger.passRate < champion.passRate) {
    return {
      verdict: 'reject',
      reasons: [`通过率 ${(challenger.passRate * 100).toFixed(0)}% 低于冠军 ${(champion.passRate * 100).toFixed(0)}%（回归）`],
      champion,
      challenger,
    }
  }

  const improved = challenger.passRate > champion.passRate
  const costRatio = champion.avgTokens > 0 ? challenger.avgTokens / champion.avgTokens - 1 : 0

  // 红线 4：成本——没有质量收益就不许变贵
  if (!improved && costRatio > policy.maxCostRatio) {
    return {
      verdict: 'reject',
      reasons: [
        `平均 token 上涨 ${(costRatio * 100).toFixed(0)}% 超过容忍 ${(policy.maxCostRatio * 100).toFixed(0)}%，且通过率无提升`,
      ],
      champion,
      challenger,
    }
  }

  if (!improved) {
    if (policy.allowTiePromotion) {
      reasons.push(`与冠军持平但成本 ${costRatio <= 0 ? '未涨' : `涨 ${((1 + costRatio) * 100 - 100).toFixed(0)}%`}: 策略允许直接晋级`)
      return { verdict: 'promote', reasons, champion, challenger }
    }
    return {
      verdict: 'needs_human',
      reasons: ['与冠军持平：是否值得替换由人工决定'],
      champion,
      challenger,
    }
  }

  reasons.push(
    `通过率 ${(champion.passRate * 100).toFixed(0)}% → ${(challenger.passRate * 100).toFixed(0)}%`,
    costRatio <= policy.maxCostRatio
      ? `平均 token 变化 ${(costRatio * 100).toFixed(0)}% 在容忍内`
      : `平均 token 上涨 ${(costRatio * 100).toFixed(0)}% 但质量提升，接受`,
    'hidden canary 全部通过',
  )
  return { verdict: 'promote', reasons, champion, challenger }
}
