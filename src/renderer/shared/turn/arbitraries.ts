/**
 * fast-check arbitraries for the shared turn machine.
 *
 * The hand-rolled {@link ./harness} generator (seeded PRNG) proves the machine
 * survives long realistic sequences; these arbitraries add SHRINKING, so a
 * violated property reports the minimal interleaving that breaks it instead of a
 * 30-step trace.
 *
 * Ids are drawn from a tiny pool on purpose: collisions between the optimistic
 * request, the command result, and the event stream are exactly where the
 * interesting races live. `FRESH_TURN_ID` / `FRESH_SESSION_ID` are deliberately
 * OUTSIDE the pool so a property can construct an identity the sequence cannot
 * have retired yet.
 *
 * Contains ZERO machine logic — it only describes inputs.
 */

import fc from 'fast-check'

import type { TurnInput, TurnKind } from './turn-machine'

export interface ArbPool {
  readonly sessions: readonly string[]
  readonly turns: readonly string[]
  readonly kinds: readonly TurnKind[]
}

export const DEFAULT_ARB_POOL: ArbPool = {
  sessions: ['s1', 's2'],
  turns: ['t0', 't1', 't2'],
  kinds: ['solve', 'chat'],
}

/** An id the generated sequences can never have produced or retired. */
export const FRESH_TURN_ID = 'fresh-turn'
export const FRESH_SESSION_ID = 'fresh-session'

const from = <T>(items: readonly T[]): fc.Arbitrary<T> => fc.constantFrom(...items)

/** A single well-typed machine input. */
export function turnInputArb(pool: ArbPool = DEFAULT_ARB_POOL): fc.Arbitrary<TurnInput> {
  const sessionId = from(pool.sessions)
  const turnId = from(pool.turns)
  const kind = from(pool.kinds)

  return fc.oneof(
    // `initiate` sometimes carries no sessionId, to exercise the
    // "nothing latched yet" branch.
    fc.record({ type: fc.constant('initiate' as const), kind, sessionId: fc.option(sessionId, { nil: undefined }) }),
    fc.record({ type: fc.constant('started' as const), kind, sessionId, turnId }),
    fc.record({ type: fc.constant('commandSettled' as const), sessionId, turnId }),
    fc.record({ type: fc.constant('commandFailed' as const) }),
    fc.record({ type: fc.constant('streamEvent' as const), sessionId, turnId }),
    fc.record({
      type: fc.constant('terminal' as const),
      sessionId,
      turnId,
      outcome: fc.constantFrom('complete' as const, 'failed' as const),
    }),
    fc.record({ type: fc.constant('dismiss' as const) }),
    fc.record({ type: fc.constant('stopSettled' as const), ok: fc.boolean() }),
    fc.record({ type: fc.constant('reset' as const), stopActive: fc.boolean() }),
  )
}

/** A sequence of machine inputs; shrinks towards the shortest failing prefix. */
export function turnInputsArb(
  options: { minLength?: number; maxLength?: number; pool?: ArbPool } = {},
): fc.Arbitrary<TurnInput[]> {
  return fc.array(turnInputArb(options.pool ?? DEFAULT_ARB_POOL), {
    minLength: options.minLength ?? 0,
    maxLength: options.maxLength ?? 14,
  })
}
