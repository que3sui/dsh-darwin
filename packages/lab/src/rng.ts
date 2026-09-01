/** mulberry32 种子 RNG：全部实验可复现 */
export interface Rng {
  next(): number
  bernoulli(p: number): boolean
  int(maxExclusive: number): number
}

export function mulberry32(seed: number): Rng {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    bernoulli: (p) => next() < p,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
  }
}
