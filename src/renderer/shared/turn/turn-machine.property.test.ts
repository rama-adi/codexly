import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { DEFAULT_ARB_POOL, FRESH_SESSION_ID, FRESH_TURN_ID, turnInputsArb } from './arbitraries'
import {
  checkInvariants,
  deepEqual,
  deepFreeze,
  driveWithStops,
  runInputs,
  stopTurnIds,
  traceInputs,
} from './harness'
import {
  IDLE_TURN,
  MAX_IGNORED_TURN_IDS,
  canStop,
  reduceTurn,
  type TurnInput,
  type TurnState,
} from './turn-machine'

/**
 * Property-based layer over the shared turn machine, complementing the seeded
 * fuzz in `chaos.test.ts`. The seeded fuzz proves the machine survives long
 * realistic traffic; fast-check adds SHRINKING, so a broken invariant is
 * reported as the minimal interleaving rather than a 30-step trace.
 *
 * The machine is owned elsewhere and is NOT modified from here.
 */

const RUNS = 400

/** Shared config so a failure is reproducible from the printed seed/path. */
const cfg = (numRuns = RUNS): fc.Parameters<unknown> => ({ numRuns, verbose: false })

/** A state reached by folding an arbitrary input sequence, kept with its path. */
const reachableArb = turnInputsArb({ maxLength: 16 }).map((inputs) => ({
  inputs,
  state: runInputs(inputs).state,
}))

/** The identity a still-unlatched turn would settle on: latched, else brand new. */
const settleIdentity = (state: TurnState) => ({
  sessionId: state.scope.sessionId ?? FRESH_SESSION_ID,
  turnId: state.scope.turnId ?? FRESH_TURN_ID,
})

describe('property — invariants hold for every arbitrary interleaving', () => {
  it('no invariant is violated on any intermediate state', () => {
    fc.assert(
      fc.property(turnInputsArb({ maxLength: 24 }), (inputs) => {
        expect(checkInvariants(traceInputs(inputs))).toEqual([])
      }),
      cfg(),
    )
  })

  it('ignoredTurnIds stays capped for arbitrary sequences over a large id pool', () => {
    const pool = {
      ...DEFAULT_ARB_POOL,
      turns: Array.from({ length: 40 }, (_, i) => `t${i}`),
    }
    fc.assert(
      fc.property(turnInputsArb({ maxLength: 300, pool }), (inputs) => {
        for (const step of traceInputs(inputs)) {
          expect(step.result.state.ignoredTurnIds.length).toBeLessThanOrEqual(MAX_IGNORED_TURN_IDS)
        }
      }),
      cfg(60),
    )
  })

  it('an idle state is always fully reset — no stray flags or scope survive', () => {
    fc.assert(
      fc.property(reachableArb, ({ state }) => {
        fc.pre(state.phase === 'idle')
        expect(state).toEqual({ ...IDLE_TURN, ignoredTurnIds: state.ignoredTurnIds })
      }),
      cfg(),
    )
  })
})

describe('property — purity', () => {
  it('is pure: the same (state, input) yields deeply equal results and no mutation', () => {
    fc.assert(
      fc.property(reachableArb, turnInputsArb({ minLength: 1, maxLength: 1 }), ({ state }, [input]) => {
        const frozen = deepFreeze(JSON.parse(JSON.stringify(state)) as TurnState)
        const a = reduceTurn(frozen, input)
        const b = reduceTurn(frozen, input)
        expect(deepEqual(a, b)).toBe(true)
      }),
      cfg(),
    )
  })
})

describe('property — the surface can never wedge in a busy state', () => {
  it('a settled command followed by its terminal event always releases the surface', () => {
    fc.assert(
      fc.property(reachableArb, ({ state }) => {
        fc.pre(state.phase === 'active')
        const id = settleIdentity(state)
        // A stop already in flight is always acknowledged eventually.
        const prefix: TurnInput[] = state.stopInFlight ? [{ type: 'stopSettled', ok: true }] : []
        const released = driveWithStops(state, [
          ...prefix,
          { type: 'commandSettled', ...id },
          { type: 'terminal', ...id, outcome: 'complete' },
        ])
        expect(released.phase).toBe('idle')
      }),
      cfg(),
    )
  })

  it('a rejected command always releases the surface', () => {
    fc.assert(
      fc.property(reachableArb, ({ state }) => {
        expect(reduceTurn(state, { type: 'commandFailed' }).state.phase).toBe('idle')
      }),
      cfg(),
    )
  })

  it('reset always releases the surface', () => {
    fc.assert(
      fc.property(reachableArb, fc.boolean(), ({ state }, stopActive) => {
        expect(reduceTurn(state, { type: 'reset', stopActive }).state.phase).toBe('idle')
      }),
      cfg(),
    )
  })

  it('pressing Stop on a stoppable turn releases the surface once the stop succeeds', () => {
    fc.assert(
      fc.property(reachableArb, ({ state }) => {
        fc.pre(canStop(state))
        expect(driveWithStops(state, [{ type: 'dismiss' }]).phase).toBe('idle')
      }),
      cfg(),
    )
  })
})

describe('property — Stop is reachable for every live turn', () => {
  it('a live turn either is stoppable already or becomes stoppable when the command settles', () => {
    fc.assert(
      fc.property(reachableArb, ({ state }) => {
        fc.pre(state.phase === 'active' && !state.terminal && !state.dismissed)
        if (canStop(state)) return
        // The only reason a live, undismissed turn cannot be stopped is that its
        // turnId is not known yet — and the command result supplies it.
        expect(state.scope.turnId).toBeUndefined()
        const settled = reduceTurn(state, { type: 'commandSettled', ...settleIdentity(state) })
        expect(canStop(settled.state)).toBe(true)
      }),
      cfg(),
    )
  })

  it('never offers Stop for a turn that has terminated or been dismissed', () => {
    fc.assert(
      fc.property(reachableArb, ({ state }) => {
        if (state.terminal || state.dismissed || state.phase === 'idle') {
          expect(canStop(state)).toBe(false)
        }
      }),
      cfg(),
    )
  })
})

describe('property — scope and effect discipline', () => {
  it('an accepted transcript event always leaves the scope latched onto that event', () => {
    fc.assert(
      fc.property(reachableArb, turnInputsArb({ minLength: 1, maxLength: 1 }), ({ state }, [input]) => {
        fc.pre(input.type === 'streamEvent' || input.type === 'terminal' || input.type === 'started')
        const result = reduceTurn(state, input)
        fc.pre(result.accepted)
        const event = input as Extract<TurnInput, { sessionId: string; turnId: string }>
        // `terminal` may return straight to idle (which clears the scope); in
        // every other case the surface must now own exactly that identity.
        if (result.state.phase === 'active') {
          expect(result.state.scope.turnId).toBe(event.turnId)
          expect(result.state.scope.sessionId).toBe(event.sessionId)
        }
      }),
      cfg(),
    )
  })

  it('only ever asks to stop a turn it owns or was just handed', () => {
    fc.assert(
      fc.property(reachableArb, turnInputsArb({ minLength: 1, maxLength: 1 }), ({ state }, [input]) => {
        const result = reduceTurn(state, input)
        const legitimate = new Set(
          [state.scope.turnId, 'turnId' in input ? input.turnId : undefined].filter(
            (id): id is string => id !== undefined,
          ),
        )
        for (const effect of result.effects) {
          if (effect.type === 'stopTurn') expect(legitimate.has(effect.turnId)).toBe(true)
        }
      }),
      cfg(),
    )
  })

  it('reports freshStart only for a genuinely new request', () => {
    fc.assert(
      fc.property(reachableArb, turnInputsArb({ minLength: 1, maxLength: 1 }), ({ state }, [input]) => {
        const result = reduceTurn(state, input)
        fc.pre(result.freshStart)
        expect(['initiate', 'started']).toContain(input.type)
        expect(result.state.phase).toBe('active')
        expect(state.phase).toBe('idle')
      }),
      cfg(),
    )
  })
})

describe('regression — a retired turnId can never be adopted by a live request', () => {
  /**
   * Found by the liveness property (fast-check shrank it to these four inputs).
   * A turn is retired while its remote counterpart is left running (an abandoning
   * `reset`), then a LATE identity announcement for that dead id arrives after a
   * new local request started. Before the fix the machine latched the retired id
   * onto the fresh request, and because every stream/terminal event for a retired
   * id is dropped, nothing could ever finish that request: the composer stayed
   * disabled until a `commandFailed`/`reset`, i.e. a permanent wedge.
   */
  const abandoned = runInputs([
    { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't0' },
    { type: 'reset', stopActive: false },
    { type: 'initiate', kind: 'solve' },
  ]).state

  it('ignores a late `started` for a retired turn instead of latching it', () => {
    const late = reduceTurn(abandoned, { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't0' })
    expect(late.accepted).toBe(false)
    expect(late.state).toEqual(abandoned)

    // The fresh request is still completable by its own identity.
    const done = runInputs(
      [
        { type: 'commandSettled', sessionId: 's1', turnId: 't9' },
        { type: 'terminal', sessionId: 's1', turnId: 't9', outcome: 'complete' },
      ],
      late.state,
    )
    expect(done.state.phase).toBe('idle')
  })

  it('treats a commandSettled that hands back a retired turn as an identity conflict', () => {
    const settled = reduceTurn(abandoned, { type: 'commandSettled', sessionId: 's1', turnId: 't0' })
    expect(settled.state.phase).toBe('idle')
    expect(stopTurnIds([...settled.effects])).toEqual(['t0'])
    expect(settled.effects.some((effect) => effect.type === 'reportError')).toBe(true)
  })

  it('still reconciles the turn that retired ITSELF on a terminal-before-settle', () => {
    // The exempted case: `terminal` retires its own id while the request stays
    // active, and that request's own commandSettled must still finish it.
    const terminalFirst = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ]).state
    expect(terminalFirst.ignoredTurnIds).toContain('t1')
    const done = reduceTurn(terminalFirst, { type: 'commandSettled', sessionId: 's1', turnId: 't1' })
    expect(done.state.phase).toBe('idle')
    expect(stopTurnIds([...done.effects])).toEqual([])
  })
})

describe('property — retired turns stay dead', () => {
  it('never accepts a transcript event for an already-retired turnId', () => {
    fc.assert(
      fc.property(reachableArb, turnInputsArb({ minLength: 1, maxLength: 1 }), ({ state }, [input]) => {
        fc.pre(input.type === 'streamEvent' || input.type === 'terminal')
        const event = input as Extract<TurnInput, { turnId: string }>
        fc.pre(state.ignoredTurnIds.includes(event.turnId))
        const result = reduceTurn(state, input)
        expect(result.accepted).toBe(false)
        expect(result.state).toEqual(state)
      }),
      cfg(),
    )
  })

  it('a retired turnId can never restart a request from idle', () => {
    fc.assert(
      fc.property(reachableArb, turnInputsArb({ minLength: 1, maxLength: 1 }), ({ state }, [input]) => {
        fc.pre(state.phase === 'idle' && 'turnId' in input)
        fc.pre(state.ignoredTurnIds.includes((input as Extract<TurnInput, { turnId: string }>).turnId))
        expect(reduceTurn(state, input).state.phase).toBe('idle')
      }),
      cfg(),
    )
  })
})
