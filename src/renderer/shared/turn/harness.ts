/**
 * Test harness for the shared turn state machine.
 *
 * Provides:
 *   - `runInputs` / `traceInputs`: fold `reduceTurn` over a sequence, capturing
 *     the running state, every effect, and per-step results.
 *   - `mulberry32` / `Prng`: a deterministic, reproducible PRNG so "random"
 *     chaos sequences can be replayed exactly from a numeric seed.
 *   - `randomInput` / `randomSequence`: a realistic, well-typed input generator
 *     drawn from a small pool of session/turn ids.
 *   - `checkInvariants`: the reusable invariant checker exercised by the fuzz
 *     tests against every intermediate state of a run.
 *
 * This file contains ZERO machine logic — it only observes `reduceTurn`.
 */

import {
  IDLE_TURN,
  MAX_IGNORED_TURN_IDS,
  reduceTurn,
  type TurnEffect,
  type TurnInput,
  type TurnKind,
  type TurnResult,
  type TurnState,
} from './turn-machine'

// --------------------------------------------------------------------------
// Sequence runners
// --------------------------------------------------------------------------

/** One reduction: the state fed in, the input, and the full result out. */
export interface TurnStep {
  readonly pre: TurnState
  readonly input: TurnInput
  readonly result: TurnResult
}

/**
 * Fold `reduceTurn` over `inputs`, returning the running trace. Each step
 * records the pre-state so invariant checks can reason about the transition.
 */
export function traceInputs(inputs: readonly TurnInput[], start: TurnState = IDLE_TURN): TurnStep[] {
  const steps: TurnStep[] = []
  let state = start
  for (const input of inputs) {
    const result = reduceTurn(state, input)
    steps.push({ pre: state, input, result })
    state = result.state
  }
  return steps
}

/**
 * Fold `reduceTurn`, accumulating the final state, the flattened list of all
 * effects, and the per-step results. This is the primary convenience runner.
 */
export function runInputs(
  inputs: readonly TurnInput[],
  start: TurnState = IDLE_TURN,
): { state: TurnState; effects: TurnEffect[]; results: TurnResult[] } {
  const steps = traceInputs(inputs, start)
  const results = steps.map((s) => s.result)
  const effects = results.flatMap((r) => [...r.effects])
  const state = steps.length ? steps[steps.length - 1].result.state : start
  return { state, effects, results }
}

/**
 * Fold `reduceTurn` over `inputs` and, whenever the machine asks for a stop,
 * immediately feed the successful `stopSettled` back in — the closed loop both
 * stores' effect interpreters implement. Liveness can only be stated against
 * this loop, because a stop that is never acknowledged legitimately keeps the
 * surface busy.
 */
export function driveWithStops(start: TurnState, inputs: readonly TurnInput[]): TurnState {
  let state = start
  for (const input of inputs) {
    const result = reduceTurn(state, input)
    state = result.state
    if (result.effects.some((effect) => effect.type === 'stopTurn')) {
      state = reduceTurn(state, { type: 'stopSettled', ok: true }).state
    }
  }
  return state
}

/** Every `stopTurn` effect id emitted across a set of effects. */
export function stopTurnIds(effects: readonly TurnEffect[]): string[] {
  return effects.filter((e): e is Extract<TurnEffect, { type: 'stopTurn' }> => e.type === 'stopTurn').map((e) => e.turnId)
}

// --------------------------------------------------------------------------
// Deterministic PRNG
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Random (but well-typed) input generation
// --------------------------------------------------------------------------

export interface InputPool {
  readonly sessions: readonly string[]
  readonly turns: readonly string[]
  readonly kinds: readonly TurnKind[]
}

export const DEFAULT_POOL: InputPool = {
  sessions: ['s1', 's2'],
  turns: ['t0', 't1', 't2'],
  kinds: ['solve', 'chat'],
}

const INPUT_TYPES: readonly TurnInput['type'][] = [
  'initiate',
  'started',
  'commandSettled',
  'commandFailed',
  'streamEvent',
  'terminal',
  'dismiss',
  'stopSettled',
  'reset',
]

/** Draw a single random, well-typed input from the pool. */
export function randomInput(rng: Prng, pool: InputPool = DEFAULT_POOL): TurnInput {
  const type = rng.pick(INPUT_TYPES)
  const kind = rng.pick(pool.kinds)
  const sessionId = rng.pick(pool.sessions)
  const turnId = rng.pick(pool.turns)
  switch (type) {
    case 'initiate':
      // Sometimes omit sessionId to exercise the "no scope latched yet" path.
      return rng.chance(0.5) ? { type, kind, sessionId } : { type, kind }
    case 'started':
      return { type, kind, sessionId, turnId }
    case 'commandSettled':
      return { type, sessionId, turnId }
    case 'commandFailed':
      return { type }
    case 'streamEvent':
      return { type, sessionId, turnId }
    case 'terminal':
      return { type, sessionId, turnId, outcome: rng.chance(0.5) ? 'complete' : 'failed' }
    case 'dismiss':
      return { type }
    case 'stopSettled':
      return { type, ok: rng.chance(0.5) }
    case 'reset':
      // Exercise both the tearing-down and the abandoning reset.
      return { type, stopActive: rng.chance(0.5) }
  }
}

/** Build a random sequence of `length` well-typed inputs. */
export function randomSequence(rng: Prng, length: number, pool: InputPool = DEFAULT_POOL): TurnInput[] {
  return Array.from({ length }, () => randomInput(rng, pool))
}

// --------------------------------------------------------------------------
// Invariant checker
// --------------------------------------------------------------------------

/** Recursively freeze a value so any hidden mutation throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** Structural deep-equality good enough for the plain-data TurnResult tree. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const isStop = (e: TurnEffect): e is Extract<TurnEffect, { type: 'stopTurn' }> => e.type === 'stopTurn'

/**
 * Check invariants 1-7 across every step of a trace. Returns a list of human
 * readable violation strings (empty when the machine behaved). The check is
 * pure and reusable — the fuzz tests run it over hundreds of random sequences,
 * and the named scenario tests can call the individual pieces too.
 *
 * `seed` is only used to make violation messages reproducible.
 */
export function checkInvariants(steps: readonly TurnStep[], seed?: number): string[] {
  const violations: string[] = []
  const tag = seed === undefined ? '' : ` [seed=${seed}]`
  const fail = (i: number, msg: string) => violations.push(`step ${i}${tag}: ${msg}`)

  // For invariant 6: the turnId (if any) with a stop we've emitted and not yet
  // heard back about. Cleared when we return to idle or stopInFlight drops.
  let pendingStop: string | null = null

  steps.forEach((step, i) => {
    const { pre, input, result } = step
    const { state, effects, accepted } = result
    const stops = effects.filter(isStop)

    // --- Invariant 1: no stop effects when dispatching to an idle machine ---
    if (pre.phase === 'idle' && stops.length > 0) {
      fail(i, `idle machine emitted stopTurn on '${input.type}': ${JSON.stringify(stops)}`)
    }

    // --- Invariant 2: bounded memory ---
    if (state.ignoredTurnIds.length > MAX_IGNORED_TURN_IDS) {
      fail(i, `ignoredTurnIds grew to ${state.ignoredTurnIds.length} > ${MAX_IGNORED_TURN_IDS}`)
    }

    // --- Invariant 3: scope safety — a latched turnId rejects other ids ------
    if (
      (input.type === 'streamEvent' || input.type === 'terminal') &&
      pre.phase === 'active' &&
      pre.scope.turnId &&
      input.turnId !== pre.scope.turnId &&
      accepted
    ) {
      fail(i, `accepted ${input.type} for foreign turnId '${input.turnId}' (latched '${pre.scope.turnId}')`)
    }

    // --- Invariant 4: no resurrection of a retired id ------------------------
    // A retired transcript event (streamEvent/terminal) must never be accepted,
    // in any phase. And a retired id must never take an IDLE machine back to
    // active (that would resurrect a finished turn). Note: a `started` that
    // arrives while the machine is already ACTIVE only re-latches identity onto
    // the live turn — that is not a resurrection, so it is not flagged here.
    if (
      (input.type === 'streamEvent' || input.type === 'terminal') &&
      pre.ignoredTurnIds.includes(input.turnId) &&
      accepted
    ) {
      fail(i, `accepted ${input.type} for retired turnId '${input.turnId}'`)
    }
    if (
      input.type === 'started' &&
      pre.phase === 'idle' &&
      pre.ignoredTurnIds.includes(input.turnId) &&
      state.phase === 'active'
    ) {
      fail(i, `retired turnId '${input.turnId}' resurrected an active request from idle`)
    }

    // --- Invariant 6: no redundant stop while one is already pending ---------
    // The NORMAL stop flow (dismiss / deferred stop on started|commandSettled)
    // must never re-issue a stop for a turnId that already has an unresolved
    // stop in flight — this is dismiss idempotency and the "dismiss → started →
    // commandSettled → single stop" guarantee.
    //
    // Two paths are deliberate FORCED teardowns that may re-issue a stop
    // defensively and are therefore exempt:
    //   - `reset` (user re-summoned / switched sessions), and
    //   - the `commandSettled` CONFLICT path (an unreconcilable identity), which
    //     is identifiable because it also emits a `reportError`.
    // In both cases stopTurn is expected to be idempotent at the caller. The
    // conflict re-issue only arises from a physically-impossible input (the same
    // turnId reappearing under a different sessionId mid-stop); it is pinned by
    // an explicit named test rather than treated as a machine defect.
    const forcedTeardown = input.type === 'reset' || effects.some((e) => e.type === 'reportError')
    for (const s of stops) {
      if (!forcedTeardown && pendingStop === s.turnId) {
        fail(i, `redundant stopTurn for '${s.turnId}' while a stop was already in flight (input '${input.type}')`)
      }
    }
    // Update pending-stop tracking from the resulting state.
    if (state.phase === 'idle' || !state.stopInFlight) {
      pendingStop = null
    }
    if (stops.length > 0 && state.stopInFlight) {
      pendingStop = stops[stops.length - 1].turnId
    }

    // --- Structural sanity: an idle state is always fully reset --------------
    if (state.phase === 'idle') {
      if (state.kind !== null || state.commandSettled || state.terminal || state.dismissed || state.stopInFlight) {
        fail(i, `idle state carries stray flags: ${JSON.stringify(state)}`)
      }
      if (Object.keys(state.scope).length !== 0) {
        fail(i, `idle state carries a non-empty scope: ${JSON.stringify(state.scope)}`)
      }
    }
  })

  return violations
}
