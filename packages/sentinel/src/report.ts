import type { ProblemTicket, ProblemKind } from './protocol.ts'

const KIND_LABEL: Record<ProblemKind, string> = {
  'retry-loop': '重试环',
  'tool-error-cluster': '工具错误簇',
  'interrupted-turn': '高频中断',
  'token-waste': 'Token 浪费',
  'context-bloat': '上下文膨胀',
  custom: '其他',
}

export function renderTicketReport(tickets: ProblemTicket[], top = 10): string {
  const open = tickets
    .filter((t) => t.status === 'open' || t.status === 'claimed')
    .sort((a, b) => b.severity - a.severity)
  if (open.length === 0) {
    return 'dsh-darwin-sentinel：当前没有开放的问题工单。运行 darwin_scan 触发一次扫描。'
  }
  const lines: string[] = [`## dsh-darwin-sentinel 会话体检（开放工单 ${open.length}）`, '']
  for (const t of open.slice(0, top)) {
    lines.push(
      `### [${t.severity}] ${KIND_LABEL[t.kind]} · ${t.title}`,
      `- id: \`${t.id}\` · 累计 ${t.occurrences} 次 · 浪费 ~${t.wastedTokensEstimate} tokens · 最近 seen ${new Date(t.lastSeenAt).toISOString()}`,
    )
    for (const e of t.evidence.slice(-3)) {
      lines.push(`  - [${e.sessionId}#${e.seq}] ${e.summary}`)
    }
    lines.push('')
  }
  if (open.length > top) lines.push(`…其余 ${open.length - top} 条见 storageDomain \`${'darwin'}/tickets\``)
  return lines.join('\n')
}
