import { Prng } from './random'

/**
 * The clock/id/random seam every fixture factory draws from. Factories never
 * touch `Date.now()` or `Math.random()`: ids are counter-based and timestamps
 * step deterministically from a fixed origin, so two calls with fresh contexts
 * produce byte-identical fixtures while a shared context produces a unique,
 * ordered stream.
 */
export interface FixtureContext {
  readonly seed: number
  /** `${prefix}-1`, `${prefix}-2`, ... per prefix. */
  nextId(prefix: string): string
  /** The next timestamp in the deterministic sequence. */
  nextTimestamp(): string
  /** A fixed timestamp offset from the context origin, independent of the counters. */
  timestampAt(step: number): string
  /** Deterministic float in [0, 1). */
  random(): number
  readonly prng: Prng
}

export interface FixtureContextOptions {
  seed?: number
  /** ISO timestamp the deterministic clock starts from. */
  startedAt?: string
  /** Milliseconds added per `nextTimestamp()` / per `timestampAt` step. */
  stepMs?: number
}

export const FIXTURE_SEED = 20260101
export const FIXTURE_EPOCH = '2026-01-01T00:00:00.000Z'
export const FIXTURE_STEP_MS = 1_000

export function createFixtureContext(options: FixtureContextOptions = {}): FixtureContext {
  const seed = options.seed ?? FIXTURE_SEED
  const stepMs = options.stepMs ?? FIXTURE_STEP_MS
  const origin = Date.parse(options.startedAt ?? FIXTURE_EPOCH)
  if (Number.isNaN(origin)) {
    throw new Error(`createFixtureContext: invalid startedAt '${String(options.startedAt)}'`)
  }
  const counters = new Map<string, number>()
  const prng = new Prng(seed)
  let clockStep = 0

  const timestampAt = (step: number): string => new Date(origin + step * stepMs).toISOString()

  return {
    seed,
    prng,
    nextId(prefix) {
      const next = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, next)
      return `${prefix}-${next}`
    },
    nextTimestamp() {
      clockStep += 1
      return timestampAt(clockStep)
    },
    timestampAt,
    random() {
      return prng.next()
    },
  }
}

/**
 * Merge overrides onto defaults while dropping `undefined` values, so an
 * explicitly-undefined override never materialises a key that the `.strict()`
 * schemas would reject as unrecognised.
 */
export function mergeDefined<Base extends object>(base: Base, overrides: object): Base {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as Base
}
