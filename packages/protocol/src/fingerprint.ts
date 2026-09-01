/**
 * 稳定指纹与相似度工具（纯函数，无 IO）。
 * fingerprint 必须跨进程、跨版本稳定：同一类问题在两次扫描间生成同一键，
 * 这样 distiller 才能合并工单而不是无限新建。
 */

/** FNV-1a 32bit，两粒种子拼接成 16 位 hex——足够避免日常碰撞且无依赖 */
export function fnv1a(input: string): string {
  const hash = (seed: number): number => {
    let h = seed
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }
  return (hash(0x811c9dc5).toString(16).padStart(8, '0') + hash(0x9747b28c).toString(16).padStart(8, '0'))
}

/**
 * 归一化聚类键：小写化、把易变数字（时间戳/计数/路径版本号）压平成 `#`，
 * 避免 `bash:exit code 137` 和 `bash:exit code 143` 被当成两类问题。
 */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/#+/g, '#')
    .trim()
}

/** scope 用途隔离（'ticket' / 'candidate' / ...），防止不同对象撞指纹 */
export function fingerprintOf(scope: string, key: string): string {
  return fnv1a(`${scope}│${normalizeKey(key)}`)
}

/** 词级 Jaccard 相似度，用于工单/候选近重复拒绝（阈值参照 0.8，ZK-Andy 惯例） */
export function jaccardSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter((w) => w.length > 0),
    )
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

export interface SeverityInput {
  occurrences: number
  wastedTokens: number
  lastSeenAt: number
  now: number
}

/**
 * 严重度 0-100：
 *   基础分 = min(60, occurrences × 8)
 *   浪费分 = min(30, wastedTokens / 1000 × 3)   （每 1k token 计 3 分）
 *   新近分 = ≤1 天 +10，≤7 天 +5
 */
export function computeSeverity(p: SeverityInput): number {
  const base = Math.min(60, p.occurrences * 8)
  const waste = Math.min(30, (p.wastedTokens / 1000) * 3)
  const days = (p.now - p.lastSeenAt) / 86_400_000
  const recency = days <= 1 ? 10 : days <= 7 ? 5 : 0
  return Math.max(0, Math.min(100, Math.round(base + waste + recency)))
}
