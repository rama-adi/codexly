import { describe, expect, it } from 'vitest'

import {
  DEFAULT_POOL,
  Prng,
  checkInvariants,
  deepEqual,
  deepFreeze,
  randomSequence,
  runInputs,
  stopTurnIds,
  traceInputs,
} from './harness'
import {
  IDLE_TURN,
  MAX_IGNORED_TURN_IDS,
  canStop,
  isStreaming,
  reduceTurn,
  type TurnInput,
  type TurnState,
} from './turn-machine'

/**
 * Adversarial / chaos suite for the overlay turn machine.
 *
 * Codex delivers three racing async sources (local request, IPC command
 * result, event stream) and the user can preempt at any moment. Real Codex
 * traffic is flaky: events arrive out of order, duplicated, dropped, delayed,
 * or failing. These tests prove the pure reducer survives all of it.
 *
 * The machine is owned elsewhere and MUST NOT be modified here. If a random
 * sequence exposes a genuine machine defect, the offending assertion is marked
 * with a clear comment and the reproducing sequence + seed is reported, while
 * the rest of the suite stays green.
 */

// --------------------------------------------------------------------------
// Explicit chaos scenarios
// --------------------------------------------------------------------------

describe('chaos — events arrive before the command settles', () => {
  it('started + deltas + terminal all before commandSettled, WITH an eventual settle → idle', () => {
    const { state, effects } = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'streamEvent', sessionId: 's1', turnId: 't1' },
      { type: 'streamEvent', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ])
    expect(state.phase).toBe('idle')
    expect(state.ignoredTurnIds).toContain('t1')
    expect(stopTurnIds(effects)).toEqual([])
  })

  it('started + deltas + terminal before commandSettled, WITHOUT a settle → stays terminal-but-active', () => {
    // Without the command result the machine cannot fully reconcile; it must
    // keep the request alive (terminal latched) so a later settle can finish it.
    const { state } = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ])
    expect(state.phase).toBe('active')
    expect(state.terminal).toBe(true)
    expect(state.commandSettled).toBe(false)
    // Terminal means no longer streaming, and it can no longer be stopped.
    expect(isStreaming(state)).toBe(false)
    expect(canStop(state)).toBe(false)
  })

  it('terminal-before-settle is finished by a later commandSettled (invariant 5, terminal-first)', () => {
    const pre = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'failed' },
    ]).state
    expect(pre.phase).toBe('active')
    const done = reduceTurn(pre, { type: 'commandSettled', sessionId: 's1', turnId: 't1' })
    expect(done.state.phase).toBe('idle')
    expect(done.state.ignoredTurnIds).toContain('t1')
  })
})

describe('chaos — duplicated events', () => {
  it('duplicate `started` for the same id is a harmless no-op', () => {
    const first = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
    ])
    const second = reduceTurn(first.state, { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' })
    expect(second.accepted).toBe(true)
    expect(second.state.scope.turnId).toBe('t1')
    expect(second.state.phase).toBe('active')
    // No spurious stop from a duplicate started.
    expect(stopTurnIds([...second.effects])).toEqual([])
  })

  it('duplicate `terminal` for the same id does not double-fire or resurrect', () => {
    const settled = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ]).state
    const first = reduceTurn(settled, { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' })
    expect(first.state.phase).toBe('idle')
    // Second terminal lands on a retired, idle machine → dropped.
    const second = reduceTurn(first.state, { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' })
    expect(second.accepted).toBe(false)
    expect(second.state.phase).toBe('idle')
    expect(stopTurnIds([...second.effects])).toEqual([])
  })
})

describe('chaos — terminal then late stream events', () => {
  it('drops `streamEvent`s that arrive after terminal for the same id', () => {
    // terminal + commandSettled → idle+retired, so late deltas are dropped.
    const done = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ]).state
    const late = reduceTurn(done, { type: 'streamEvent', sessionId: 's1', turnId: 't1' })
    expect(late.accepted).toBe(false)
    expect(late.state.phase).toBe('idle')
  })

  it('drops late `streamEvent`s even while terminal is latched pre-settle', () => {
    // terminal arrived but command has not settled: the id is already retired,
    // so subsequent deltas for it are refused even though phase is still active.
    const pre = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ]).state
    expect(pre.phase).toBe('active')
    expect(pre.ignoredTurnIds).toContain('t1')
    const late = reduceTurn(pre, { type: 'streamEvent', sessionId: 's1', turnId: 't1' })
    expect(late.accepted).toBe(false)
  })
})

describe('chaos — user dismiss at every distinct point', () => {
  it('dismiss before the turnId is known defers the stop until commandSettled', () => {
    const dismissed = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'dismiss' },
    ])
    expect(stopTurnIds(dismissed.effects)).toEqual([])
    expect(dismissed.state.dismissed).toBe(true)
    const later = reduceTurn(dismissed.state, { type: 'commandSettled', sessionId: 's1', turnId: 't1' })
    expect(stopTurnIds([...later.effects])).toEqual(['t1'])
  })

  it('dismiss before turnId known is finished by a `started` that then stops', () => {
    const dismissed = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'dismiss' },
    ]).state
    const started = reduceTurn(dismissed, { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' })
    expect(stopTurnIds([...started.effects])).toEqual(['t1'])
    expect(started.state.stopInFlight).toBe(true)
  })

  it('dismiss mid-stream stops immediately', () => {
    const { effects, state } = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'streamEvent', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
    ])
    expect(stopTurnIds(effects)).toEqual(['t1'])
    expect(canStop(state)).toBe(false)
  })

  it('dismiss after terminal-before-settle does NOT stop (nothing left to stop)', () => {
    const pre = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ]).state
    const dismissed = reduceTurn(pre, { type: 'dismiss' })
    // Terminal already reached but command not settled: dismiss just marks the
    // request dismissed; there is no running turn to stop.
    expect(stopTurnIds([...dismissed.effects])).toEqual([])
    expect(dismissed.state.dismissed).toBe(true)
  })

  it('dismiss during stopInFlight is idempotent (no second stop)', () => {
    const stopping = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
    ])
    expect(stopTurnIds(stopping.effects)).toEqual(['t1'])
    expect(stopping.state.stopInFlight).toBe(true)
    const again = reduceTurn(stopping.state, { type: 'dismiss' })
    expect(stopTurnIds([...again.effects])).toEqual([])
  })

  it('dismiss → started → commandSettled produces exactly one stop', () => {
    const { effects } = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'dismiss' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ])
    expect(stopTurnIds(effects)).toEqual(['t1'])
  })
})

describe('chaos — stop failure revives, then a real terminal finishes it', () => {
  it('stopSettled{ok:false} revives the stream, later terminal (+settle) finishes it', () => {
    const revived = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
      { type: 'stopSettled', ok: false },
    ])
    expect(revived.state.phase).toBe('active')
    expect(revived.state.dismissed).toBe(false)
    expect(revived.state.stopInFlight).toBe(false)
    expect(isStreaming(revived.state)).toBe(true)
    // The turn is running again and can be stopped again.
    expect(canStop(revived.state)).toBe(true)
    const finished = reduceTurn(revived.state, {
      type: 'terminal',
      sessionId: 's1',
      turnId: 't1',
      outcome: 'complete',
    })
    expect(finished.state.phase).toBe('idle')
    expect(finished.state.ignoredTurnIds).toContain('t1')
  })

  it('stopSettled{ok:true} finishes and retires the turn', () => {
    const { state } = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
      { type: 'stopSettled', ok: true },
    ])
    expect(state.phase).toBe('idle')
    expect(state.ignoredTurnIds).toContain('t1')
  })
})

describe('chaos — conflicting commandSettled', () => {
  it('stops the conflicting turn, reports an error, and returns to idle', () => {
    const active = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
    ]).state
    const conflict = reduceTurn(active, { type: 'commandSettled', sessionId: 's1', turnId: 't2' })
    expect(conflict.state.phase).toBe('idle')
    expect(stopTurnIds([...conflict.effects])).toEqual(['t2'])
    expect(conflict.effects.some((e) => e.type === 'reportError')).toBe(true)
    // The conflicting id is the one retired.
    expect(conflict.state.ignoredTurnIds).toContain('t2')
  })

  it('a session-id mismatch on commandSettled is also treated as a conflict', () => {
    const active = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
    ]).state
    const conflict = reduceTurn(active, { type: 'commandSettled', sessionId: 'sX', turnId: 't1' })
    expect(conflict.state.phase).toBe('idle')
    expect(stopTurnIds([...conflict.effects])).toEqual(['t1'])
  })

  it('FORCED-TEARDOWN: dismiss then a conflicting commandSettled re-uses the same turnId → stops twice', () => {
    // Documents (and pins) the one path where the SAME turnId is stopped a
    // second time while the first stop is still in flight. It requires an input
    // Codex cannot actually emit — the same turnId reappearing under a DIFFERENT
    // sessionId mid-stop — so the conflict path cannot reconcile it and forces a
    // fresh stop + reportError. This is intended forced-teardown behaviour, not
    // a violation of "at most one stop per turn"; stopTurn is idempotent at the
    // caller. (Reproduced organically by fuzz seed 10, steps 19-20.)
    const dismissing = runInputs([
      { type: 'started', kind: 'solve', sessionId: 's2', turnId: 't2' },
      { type: 'dismiss' },
    ])
    expect(stopTurnIds(dismissing.effects)).toEqual(['t2'])
    expect(dismissing.state.stopInFlight).toBe(true)

    const conflict = reduceTurn(dismissing.state, { type: 'commandSettled', sessionId: 's1', turnId: 't2' })
    expect(stopTurnIds([...conflict.effects])).toEqual(['t2'])
    expect(conflict.effects.some((e) => e.type === 'reportError')).toBe(true)
    expect(conflict.state.phase).toBe('idle')
  })
})

describe('chaos — overlayReset', () => {
  it('stops the active turn while active', () => {
    const active = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
    ]).state
    const reset = reduceTurn(active, { type: 'overlayReset' })
    expect(reset.state.phase).toBe('idle')
    expect(stopTurnIds([...reset.effects])).toEqual(['t1'])
    expect(reset.state.ignoredTurnIds).toContain('t1')
  })

  it('is a pure no-op (no effects) while idle', () => {
    const reset = reduceTurn(IDLE_TURN, { type: 'overlayReset' })
    expect(reset.state.phase).toBe('idle')
    expect(reset.effects).toEqual([])
  })

  it('while active before the turnId is known emits no stop', () => {
    const active = runInputs([{ type: 'initiate', kind: 'chat' }]).state
    const reset = reduceTurn(active, { type: 'overlayReset' })
    expect(reset.state.phase).toBe('idle')
    expect(stopTurnIds([...reset.effects])).toEqual([])
  })
})

// --------------------------------------------------------------------------
// Invariant-focused deterministic tests
// --------------------------------------------------------------------------

describe('invariant 1 — no stop effects when idle', () => {
  const idleInputs: TurnInput[] = [
    { type: 'initiate', kind: 'solve' },
    { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    { type: 'commandFailed' },
    { type: 'streamEvent', sessionId: 's1', turnId: 't1' },
    { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    { type: 'dismiss' },
    { type: 'stopSettled', ok: true },
    { type: 'stopSettled', ok: false },
    { type: 'overlayReset' },
    { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
  ]

  for (const input of idleInputs) {
    it(`'${input.type}' from IDLE_TURN emits zero stopTurn effects`, () => {
      const { effects } = reduceTurn(IDLE_TURN, input)
      expect(stopTurnIds([...effects])).toEqual([])
    })
  }
})

describe('invariant 2 — bounded memory across many completed turns', () => {
  it('ignoredTurnIds never exceeds MAX_IGNORED_TURN_IDS after 200+ distinct turns', () => {
    const inputs: TurnInput[] = []
    for (let i = 0; i < 250; i++) {
      const turnId = `turn-${i}`
      // Each pair is a full externally-started turn that completes and retires.
      inputs.push({ type: 'started', kind: 'solve', sessionId: 's1', turnId })
      inputs.push({ type: 'terminal', sessionId: 's1', turnId, outcome: 'complete' })
    }
    const steps = traceInputs(inputs)
    const violations = checkInvariants(steps)
    expect(violations).toEqual([])
    const final = steps[steps.length - 1].result.state
    expect(final.ignoredTurnIds.length).toBe(MAX_IGNORED_TURN_IDS)
    // Retains the most-recent ids (FIFO eviction).
    expect(final.ignoredTurnIds).toContain('turn-249')
    expect(final.ignoredTurnIds).not.toContain('turn-0')
  })
})

describe('invariant 3 — scope safety', () => {
  it('never accepts stream/terminal events for a foreign turnId once latched', () => {
    const latched = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
    ]).state
    for (const foreign of ['t2', 't3', 'other']) {
      const s = reduceTurn(latched, { type: 'streamEvent', sessionId: 's1', turnId: foreign })
      expect(s.accepted).toBe(false)
      const t = reduceTurn(latched, { type: 'terminal', sessionId: 's1', turnId: foreign, outcome: 'complete' })
      expect(t.accepted).toBe(false)
      // A foreign terminal must not end the real turn.
      expect(t.state.phase).toBe('active')
    }
  })
})

describe('invariant 4 — no resurrection', () => {
  for (const outcome of ['complete', 'failed'] as const) {
    it(`late started/streamEvent/terminal after terminal(${outcome})+settle are ignored`, () => {
      const done = runInputs([
        { type: 'initiate', kind: 'solve' },
        { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
        { type: 'terminal', sessionId: 's1', turnId: 't1', outcome },
      ]).state
      expect(done.phase).toBe('idle')

      const started = reduceTurn(done, { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' })
      expect(started.state.phase).toBe('idle')

      const stream = reduceTurn(done, { type: 'streamEvent', sessionId: 's1', turnId: 't1' })
      expect(stream.accepted).toBe(false)

      const term = reduceTurn(done, { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' })
      expect(term.accepted).toBe(false)
    })
  }
})

describe('invariant 5 — termination (both orderings)', () => {
  it('commandSettled THEN terminal → idle', () => {
    const { state } = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ])
    expect(state.phase).toBe('idle')
    expect(state.ignoredTurnIds).toContain('t1')
  })

  it('terminal THEN commandSettled → idle', () => {
    const { state } = runInputs([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ])
    expect(state.phase).toBe('idle')
    expect(state.ignoredTurnIds).toContain('t1')
  })
})

describe('invariant 6 — at most one stop per turn (spirit cases)', () => {
  it('dismiss is idempotent — repeated dismisses do not re-stop', () => {
    let state = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
    ]).state
    const allStops: string[] = []
    for (const input of [{ type: 'dismiss' }, { type: 'dismiss' }, { type: 'dismiss' }] as TurnInput[]) {
      const r = reduceTurn(state, input)
      allStops.push(...stopTurnIds([...r.effects]))
      state = r.state
    }
    expect(allStops).toEqual(['t1'])
  })

  it('dismiss → started → commandSettled never double-stops', () => {
    const { effects } = runInputs([
      { type: 'initiate', kind: 'chat' },
      { type: 'dismiss' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ])
    const t1Stops = stopTurnIds(effects).filter((id) => id === 't1')
    expect(t1Stops.length).toBe(1)
  })
})

describe('invariant 7 — purity / no hidden mutation', () => {
  const cases: { name: string; state: TurnState; input: TurnInput }[] = [
    { name: 'initiate from idle', state: IDLE_TURN, input: { type: 'initiate', kind: 'solve' } },
    {
      name: 'commandSettled while active',
      state: runInputs([{ type: 'initiate', kind: 'solve' }]).state,
      input: { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    },
    {
      name: 'dismiss while streaming',
      state: runInputs([
        { type: 'initiate', kind: 'chat' },
        { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      ]).state,
      input: { type: 'dismiss' },
    },
    {
      name: 'conflicting commandSettled',
      state: runInputs([
        { type: 'initiate', kind: 'solve' },
        { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      ]).state,
      input: { type: 'commandSettled', sessionId: 's1', turnId: 't2' },
    },
  ]

  for (const { name, state, input } of cases) {
    it(`${name}: two calls are deeply equal and the input state is not mutated`, () => {
      const before = JSON.parse(JSON.stringify(state))
      const frozen = deepFreeze(JSON.parse(JSON.stringify(state)))
      // Calling on a deep-frozen copy throws if the reducer mutates it.
      const a = reduceTurn(frozen, input)
      const b = reduceTurn(frozen, input)
      expect(deepEqual(a, b)).toBe(true)
      // Original object is structurally untouched.
      expect(JSON.parse(JSON.stringify(state))).toEqual(before)
    })
  }
})

// --------------------------------------------------------------------------
// Long random fuzz — invariants 1-7 must hold on EVERY intermediate state
// --------------------------------------------------------------------------

describe('fuzz — 500 seeded random sequences of length ~30', () => {
  it('every intermediate state satisfies the invariants', () => {
    const failures: { seed: number; violations: string[]; sequence: TurnInput[] }[] = []

    for (let seed = 1; seed <= 500; seed++) {
      const rng = new Prng(seed)
      const length = 25 + rng.int(11) // ~30, in [25, 35]
      const sequence = randomSequence(rng, length, DEFAULT_POOL)
      const steps = traceInputs(sequence)
      const violations = checkInvariants(steps, seed)
      if (violations.length > 0) {
        failures.push({ seed, violations, sequence })
      }
    }

    if (failures.length > 0) {
      // Surface the first reproducing seed + full input list for the machine owner.
      const first = failures[0]
      throw new Error(
        `Invariant violations in ${failures.length}/500 seeds. First failing seed=${first.seed}\n` +
          `violations:\n  ${first.violations.join('\n  ')}\n` +
          `sequence:\n${JSON.stringify(first.sequence, null, 2)}`,
      )
    }

    expect(failures).toEqual([])
  })

  it('is reproducible — the same seed yields the same sequence and trace', () => {
    const a = randomSequence(new Prng(42), 30)
    const b = randomSequence(new Prng(42), 30)
    expect(a).toEqual(b)
    expect(runInputs(a).state).toEqual(runInputs(b).state)
  })

  it('the fuzz actually reaches active/idle transitions (coverage sanity)', () => {
    let sawActive = false
    let sawStop = false
    let sawIdleReturn = false
    for (let seed = 1; seed <= 50; seed++) {
      const rng = new Prng(seed)
      const steps = traceInputs(randomSequence(rng, 30))
      for (const s of steps) {
        if (s.result.state.phase === 'active') sawActive = true
        if (s.result.effects.some((e) => e.type === 'stopTurn')) sawStop = true
        if (s.pre.phase === 'active' && s.result.state.phase === 'idle') sawIdleReturn = true
      }
    }
    expect(sawActive).toBe(true)
    expect(sawStop).toBe(true)
    expect(sawIdleReturn).toBe(true)
  })
})
