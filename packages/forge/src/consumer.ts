import {
  jaccardSimilarity,
  type CandidatePlugin,
  type ProblemTicket,
} from './protocol.ts'

/** 从工单库挑下一个要处理的工单：open 中严重度最高者 */
export function pickNextTicket(tickets: ProblemTicket[]): ProblemTicket | undefined {
  return tickets
    .filter((t) => t.status === 'open')
    .sort((a, b) => b.severity - a.severity)[0]
}

export function markClaimed(ticket: ProblemTicket, now: number): ProblemTicket {
  return { ...ticket, status: 'claimed', updatedAt: now }
}

/**
 * 近重复拒绝：与既有候选的标题 Jaccard ≥ 阈值即视为同题已做。
 * 防止工厂对同一问题反复立项（膨胀/刷分），阈值惯例 0.8（ZK-Andy）。
 * 只比标题不比 rationale——候选 rationale 含大量元数据 token，会稀释相似度。
 */
export function findNearDuplicate(
  title: string,
  _rationale: string,
  candidates: CandidatePlugin[],
  threshold = 0.8,
): CandidatePlugin | undefined {
  for (const c of candidates) {
    if (c.status === 'rejected') continue
    if (jaccardSimilarity(title, c.title) >= threshold) return c
  }
  return undefined
}
