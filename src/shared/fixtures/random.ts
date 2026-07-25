/**
 * Deterministic pseudo-randomness shared by the fixture factories and the turn
 * machine harness. Nothing here reads the clock or `Math.random`, so any value
 * a fixture produces is reproducible from its numeric seed alone.
 */

/**
 * mulberry32 — a tiny, fast, fully deterministic 32-bit PRNG. Given the same
 * seed it always yields the same stream, so any failing fuzz sequence can be
 * reproduced by re-running with the reported seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Convenience wrapper around mulberry32 with integer/choice helpers. */
export class Prng {
  private readonly rand: () => number

  constructor(public readonly seed: number) {
    this.rand = mulberry32(seed)
  }

  /** Float in [0, 1). */
  next(): number {
    return this.rand()
  }

  /** Integer in [0, nExclusive). */
  int(nExclusive: number): number {
    return Math.floor(this.rand() * nExclusive)
  }

  /** A uniformly-chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.rand() < p
  }
}
