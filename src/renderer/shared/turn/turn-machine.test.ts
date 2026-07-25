import { describe, expect, it } from 'vitest'

import {
  IDLE_TURN,
  activeTurnId,
  canStop,
  isStreaming,
  reduceTurn,
  type TurnInput,
  type TurnState,
} from './turn-machine'

/** Fold a sequence of inputs, returning the final state and all effects. */
function run(inputs: TurnInput[], start: TurnState = IDLE_TURN) {
  let state = start
  const effects: unknown[] = []
  let last
  for (const input of inputs) {
    last = reduceTurn(state, input)
    state = last.state
    effects.push(...last.effects)
  }
  return { state, effects, last: last! }
}

describe('reduceTurn — happy paths', () => {
  it('runs a solve turn: initiate → commandSettled → deltas → complete', () => {
    const { state, effects } = run([
      { type: 'initiate', kind: 'solve' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
      { type: 'streamEvent', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ])
    expect(state.phase).toBe('idle')
    expect(effects).toEqual([])
    expect(state.ignoredTurnIds).toContain('t1')
  })

  it('latches the turn id when the event stream beats the command result', () => {
    const { state, last } = run([
      { type: 'initiate', kind: 'chat', sessionId: 's1' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
    ])
    expect(last.accepted).toBe(true)
    expect(activeTurnId(state)).toBe('t1')
    expect(isStreaming(state)).toBe(true)
  })

  it('finishes on terminal even if the command settles afterwards', () => {
    const { state } = run([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ])
    expect(state.phase).toBe('idle')
  })

  it('creates a request from an externally-started turn (solve shortcut)', () => {
    const { state, last } = run([{ type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' }])
    expect(state.phase).toBe('active')
    expect(state.commandSettled).toBe(true)
    expect(last.freshStart).toBe(true)
  })
})

describe('reduceTurn — scope gating', () => {
  it('drops events from a different turn', () => {
    const start = run([
      { type: 'initiate', kind: 'solve' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
    ]).state
    const { last } = run([{ type: 'streamEvent', sessionId: 's1', turnId: 'OTHER' }], start)
    expect(last.accepted).toBe(false)
  })

  it('never accepts events once a turn is retired', () => {
    const done = run([
      { type: 'initiate', kind: 'solve' },
      { type: 'commandSettled', sessionId: 's1', turnId: 't1' },
      { type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' },
    ]).state
    expect(done.phase).toBe('idle')
    const late = run([{ type: 'streamEvent', sessionId: 's1', turnId: 't1' }], done)
    expect(late.last.accepted).toBe(false)
    // A late `started` for the retired id must not resurrect a request.
    const resurrect = run([{ type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' }], done)
    expect(resurrect.state.phase).toBe('idle')
  })
})

describe('reduceTurn — preemption', () => {
  it('stops the turn when dismissed mid-stream', () => {
    const { last } = run([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
    ])
    expect(last.effects).toContainEqual({ type: 'stopTurn', turnId: 't1' })
    expect(last.state.dismissed).toBe(true)
    expect(canStop(last.state)).toBe(false)
  })

  it('defers the stop until the turn id is known', () => {
    const dismissed = run([
      { type: 'initiate', kind: 'chat' },
      { type: 'dismiss' },
    ])
    expect(dismissed.effects).toEqual([])
    const later = run([{ type: 'commandSettled', sessionId: 's1', turnId: 't1' }], dismissed.state)
    expect(later.effects).toContainEqual({ type: 'stopTurn', turnId: 't1' })
  })

  it('finishes when a stop resolves successfully', () => {
    const stopped = run([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
      { type: 'stopSettled', ok: true },
    ])
    expect(stopped.state.phase).toBe('idle')
    expect(stopped.state.ignoredTurnIds).toContain('t1')
  })

  it('revives the stream when a stop fails (the store surfaces the error)', () => {
    const failed = run([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
      { type: 'dismiss' },
      { type: 'stopSettled', ok: false },
    ])
    expect(failed.state.phase).toBe('active')
    expect(failed.state.dismissed).toBe(false)
    expect(failed.state.stopInFlight).toBe(false)
    // The stopSettled step itself emits nothing — error surfacing is the store's
    // job (the earlier `dismiss` step is what emitted the stopTurn).
    expect(failed.last.effects).toEqual([])
  })
})

describe('reduceTurn — conflicts & reset', () => {
  it('stops a conflicting turn when the command identity cannot be reconciled', () => {
    const start = run([
      { type: 'initiate', kind: 'solve' },
      { type: 'started', kind: 'solve', sessionId: 's1', turnId: 't1' },
    ]).state
    const conflict = run([{ type: 'commandSettled', sessionId: 's1', turnId: 't2' }], start)
    expect(conflict.state.phase).toBe('idle')
    expect(conflict.effects).toContainEqual({ type: 'stopTurn', turnId: 't2' })
    expect(conflict.effects.some((e) => (e as { type: string }).type === 'reportError')).toBe(true)
  })

  it('stops the active turn and goes idle on overlay reset', () => {
    const start = run([
      { type: 'initiate', kind: 'chat' },
      { type: 'started', kind: 'chat', sessionId: 's1', turnId: 't1' },
    ]).state
    const reset = run([{ type: 'reset', stopActive: true }], start)
    expect(reset.state.phase).toBe('idle')
    expect(reset.effects).toContainEqual({ type: 'stopTurn', turnId: 't1' })
  })
})
