import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FRESH_SESSION_ID,
  FRESH_TURN_ID,
} from '../../shared/turn/arbitraries'
import { driveWithStops } from '../../shared/turn/harness'
import {
  IDLE_TURN,
  MAX_IGNORED_TURN_IDS,
  canStop,
  isBusy,
  reduceTurn,
  type TurnInput,
  type TurnState,
} from '../../shared/turn/turn-machine'
import { createConversationActions } from './conversation-actions'
import { createConversationStore } from './conversation-store'
import type { ConversationStoreState } from './contract'

/**
 * Chaos / property suite for the HISTORY page's conversation store — the same
 * treatment `shared/turn/chaos.test.ts` gives the pure machine, applied one
 * layer up where the machine's effects actually reach a transport and the
 * composer.
 *
 * The store is driven exactly the way the real surface drives it: the send
 * action's store mutations, and the event bridge's "dispatch, then apply only if
 * accepted" rule. Everything asserted here is a user-visible guarantee:
 *
 *   - the composer can never wedge in 'sending',
 *   - Stop is reachable for every live turn,
 *   - a turn ended by anything other than a session switch / rejected command
 *     drops the optimistic bubble and asks for a refetch,
 *   - transcript buffers never grow for a terminal or quarantined turn,
 *   - the retired-turn set stays bounded.
 */

// `reportError` mirrors every failure to the console; hundreds of adversarial
// runs would drown the reporter in it.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const SESSIONS = ['sess-1', 'sess-2'] as const
const TURNS = ['turn-a', 'turn-b'] as const

type StopOutcome = 'ok' | 'refused' | 'throws'

type Action =
  | { kind: 'send'; message: string }
  | { kind: 'settled'; sessionId: string; turnId: string }
  | { kind: 'failed' }
  | { kind: 'delta'; sessionId: string; turnId: string; text: string }
  | { kind: 'reasoning'; sessionId: string; turnId: string; text: string }
  | { kind: 'terminal'; sessionId: string; turnId: string; outcome: 'complete' | 'failed' }
  | { kind: 'stop' }
  | { kind: 'select'; sessionId: string }

const sessionArb = fc.constantFrom(...SESSIONS)
const turnArb = fc.constantFrom(...TURNS)

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant('send' as const), message: fc.constantFrom('hi', 'again') }),
  fc.record({ kind: fc.constant('settled' as const), sessionId: sessionArb, turnId: turnArb }),
  fc.record({ kind: fc.constant('failed' as const) }),
  fc.record({
    kind: fc.constant('delta' as const),
    sessionId: sessionArb,
    turnId: turnArb,
    text: fc.constantFrom('x', 'yy'),
  }),
  fc.record({
    kind: fc.constant('reasoning' as const),
    sessionId: sessionArb,
    turnId: turnArb,
    text: fc.constantFrom('r', 'rr'),
  }),
  fc.record({
    kind: fc.constant('terminal' as const),
    sessionId: sessionArb,
    turnId: turnArb,
    outcome: fc.constantFrom('complete' as const, 'failed' as const),
  }),
  fc.record({ kind: fc.constant('stop' as const) }),
  fc.record({ kind: fc.constant('select' as const), sessionId: sessionArb }),
)

/** Let every queued promise callback (the stopTurn chain) run. */
async function settlePromises(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** The identity a still-unlatched turn would settle on: latched, else brand new. */
const settleIdentity = (turn: TurnState) => ({
  sessionId: turn.scope.sessionId ?? FRESH_SESSION_ID,
  turnId: turn.scope.turnId ?? FRESH_TURN_ID,
})

interface Harness {
  store: ReturnType<typeof createConversationStore>
  onTurnEnded: ReturnType<typeof vi.fn>
  stopTurn: ReturnType<typeof vi.fn>
}

function makeHarness(stopOutcomes: readonly StopOutcome[]): Harness {
  let call = 0
  const stopTurn = vi.fn(async (): Promise<boolean> => {
    const outcome = stopOutcomes[call++ % stopOutcomes.length]
    if (outcome === 'throws') throw new Error('stop transport exploded')
    return outcome === 'ok'
  })
  const onTurnEnded = vi.fn()
  const store = createConversationStore({
    transport: { stopTurn },
    onTurnEnded,
    initial: { sessionId: SESSIONS[0] },
  })
  return { store, onTurnEnded, stopTurn }
}

/**
 * Invariants that must hold after EVERY step, whatever the interleaving.
 * `label` names the step so a shrunk counterexample points at it.
 */
function checkStoreInvariants(store: Harness['store'], label: string): void {
  const state = store.getState()
  const turn = state.turn
  const at = (msg: string) => `${label}: ${msg}`

  // Bounded memory: a long-lived History page must not accumulate turn ids.
  expect(turn.ignoredTurnIds.length, at('ignoredTurnIds cap')).toBeLessThanOrEqual(
    MAX_IGNORED_TURN_IDS,
  )

  if (turn.phase === 'idle') {
    // An idle machine is the released composer, with no stray latched identity.
    expect(turn, at('idle state fully reset')).toEqual({
      ...IDLE_TURN,
      ignoredTurnIds: turn.ignoredTurnIds,
    })
    expect(isBusy(turn), at('idle means the composer is enabled')).toBe(false)
    return
  }

  // --- the composer can never wedge ----------------------------------------
  // The command promise ALWAYS settles, and its turn always terminates, so this
  // is the guaranteed release path for any busy state the surface can reach.
  const id = settleIdentity(turn)
  const pending: TurnInput[] = turn.stopInFlight ? [{ type: 'stopSettled', ok: true }] : []
  const released = driveWithStops(turn, [
    ...pending,
    { type: 'commandSettled', ...id },
    { type: 'terminal', ...id, outcome: 'complete' },
  ])
  expect(released.phase, at('a settled command + its terminal release the composer')).toBe('idle')
  expect(reduceTurn(turn, { type: 'commandFailed' }).state.phase, at('a rejected command releases')).toBe('idle')

  // --- Stop is reachable for every live turn --------------------------------
  if (!turn.terminal && !turn.dismissed && !canStop(turn)) {
    expect(turn.scope.turnId, at('only an unknown turnId can block Stop')).toBeUndefined()
    expect(
      canStop(reduceTurn(turn, { type: 'commandSettled', ...id }).state),
      at('the command result makes Stop reachable'),
    ).toBe(true)
  }
}

/**
 * Apply one action to the store the way the real surface does.
 *
 * `send` mirrors `createConversationActions.send`'s store mutations, and the
 * transcript actions mirror `useConversationEventBridge`: dispatch first, apply
 * only when the machine accepts. The sequence gating that sits between them is
 * `transcript-sync`'s own concern and is tested there.
 */
async function apply(h: Harness, action: Action, label: string): Promise<void> {
  const s = () => h.store.getState() as ConversationStoreState
  const before = s().turn
  const answerBefore = s().answer
  const reasoningBefore = s().reasoning

  switch (action.kind) {
    case 'send': {
      const sessionId = s().sessionId
      if (!sessionId || isBusy(before)) break
      s().dispatch({ type: 'initiate', kind: 'chat', sessionId })
      s().resetTranscript()
      s().set({
        composerText: '',
        composerError: undefined,
        pendingUser: {
          id: `pending-${label}`,
          sessionId,
          content: action.message,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })
      break
    }

    case 'settled':
      s().dispatch({ type: 'commandSettled', sessionId: action.sessionId, turnId: action.turnId })
      break

    case 'failed':
      s().dispatch({ type: 'commandFailed' })
      // The action layer owns the rollback.
      s().set({ pendingUser: null, composerText: 'restored' })
      break

    case 'delta':
    case 'reasoning': {
      const isAnswer = action.kind === 'delta'
      const { accepted } = s().dispatch({
        type: 'streamEvent',
        sessionId: action.sessionId,
        turnId: action.turnId,
      })
      // An idle surface and a retired turn are both closed for business.
      if (before.phase === 'idle' || before.ignoredTurnIds.includes(action.turnId)) {
        expect(accepted, `${label}: a quarantined/idle turn accepted a stream event`).toBe(false)
      }
      if (accepted) s().appendTranscript(isAnswer ? { answer: action.text } : { reasoning: action.text })
      s().flushTranscript()
      // Buffers never grow for a turn the machine refused.
      if (!accepted) {
        expect(s().answer, `${label}: answer grew on a refused event`).toBe(answerBefore)
        expect(s().reasoning, `${label}: reasoning grew on a refused event`).toBe(reasoningBefore)
      }
      break
    }

    case 'terminal': {
      const { accepted } = s().dispatch({
        type: 'terminal',
        sessionId: action.sessionId,
        turnId: action.turnId,
        outcome: action.outcome,
      })
      if (accepted) s().flushTranscript()
      break
    }

    case 'stop':
      s().dispatch({ type: 'dismiss' })
      break

    case 'select':
      s().selectSession(action.sessionId)
      break
  }

  // The stopTurn effect resolves asynchronously and dispatches stopSettled.
  await settlePromises()

  const after = h.store.getState().turn
  if (before.phase === 'active' && after.phase === 'idle') {
    // Every ending except a session switch and a rejected command hands the
    // conversation back to the persisted transcript.
    if (action.kind !== 'select' && action.kind !== 'failed') {
      expect(h.store.getState().pendingUser, `${label}: optimistic bubble survived the ending`).toBeNull()
    }
  }
  for (const call of h.onTurnEnded.mock.calls) {
    expect(typeof call[0], `${label}: onTurnEnded needs a session id`).toBe('string')
  }
  checkStoreInvariants(h.store, label)
}

describe('property — the History conversation store survives arbitrary interleavings', () => {
  it('holds every invariant after each step of any action sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(actionArb, { maxLength: 16 }),
        fc.array(fc.constantFrom<StopOutcome>('ok', 'refused', 'throws'), {
          minLength: 1,
          maxLength: 3,
        }),
        async (actions, stopOutcomes) => {
          const h = makeHarness(stopOutcomes)
          checkStoreInvariants(h.store, 'initial')
          for (const [index, action] of actions.entries()) {
            await apply(h, action, `step ${index} (${action.kind})`)
          }
        },
      ),
      { numRuns: 250 },
    )
  })

  it('never leaks a foreign session or a quarantined turn into the transcript', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { maxLength: 14 }), async (actions) => {
        const h = makeHarness(['ok'])
        for (const [index, action] of actions.entries()) {
          await apply(h, action, `step ${index} (${action.kind})`)
        }
        const state = h.store.getState()
        // Whatever happened, a foreign session can never reach this transcript…
        const foreign = state.dispatch({ type: 'streamEvent', sessionId: 'other-session', turnId: 'other-turn' })
        expect(foreign.accepted).toBe(false)
        // …nor release the composer.
        const busyBefore = isBusy(state.turn)
        const terminal = state.dispatch({
          type: 'terminal',
          sessionId: 'other-session',
          turnId: 'other-turn',
          outcome: 'complete',
        })
        expect(terminal.accepted).toBe(false)
        expect(isBusy(h.store.getState().turn)).toBe(busyBefore)
      }),
      { numRuns: 120 },
    )
  })

  it('abandoning a session quarantines its turn: no late event can grow the transcript', async () => {
    await fc.assert(
      fc.asyncProperty(turnArb, fc.array(actionArb, { maxLength: 8 }), async (turnId, tail) => {
        const h = makeHarness(['ok'])
        await apply(h, { kind: 'send', message: 'hi' }, 'send')
        await apply(h, { kind: 'settled', sessionId: SESSIONS[0], turnId }, 'settled')
        await apply(h, { kind: 'select', sessionId: SESSIONS[1] }, 'select')
        expect(h.stopTurn).not.toHaveBeenCalled()
        expect(h.store.getState().turn.ignoredTurnIds).toContain(turnId)
        for (const [index, action] of tail.entries()) {
          await apply(h, action, `tail ${index} (${action.kind})`)
        }
        // The abandoned turn is dead to this surface forever, whatever follows.
        const late = h.store
          .getState()
          .dispatch({ type: 'streamEvent', sessionId: SESSIONS[0], turnId })
        expect(late.accepted).toBe(false)
      }),
      { numRuns: 120 },
    )
  })
})

describe('property — a turnId adopted from commandSettled is stoppable immediately', () => {
  it('Stop is offered as soon as the send command resolves, before any delta', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb, turnArb, async (sessionId, turnId) => {
        const h = makeHarness(['ok'])
        const client = { sendMessage: vi.fn(async () => ({ sessionId, turnId })) }
        const actions = createConversationActions(h.store, client)

        h.store.getState().set({ sessionId, composerText: 'question' })
        const sent = actions.send('gpt-5.5')
        // While the command is in flight the composer is busy but not stoppable.
        expect(isBusy(h.store.getState().turn)).toBe(true)
        await sent

        // No stream event has arrived, yet Stop is live and actually stops.
        expect(canStop(h.store.getState().turn)).toBe(true)
        actions.stop()
        expect(h.stopTurn).toHaveBeenCalledWith(turnId)
        await settlePromises()
        expect(h.store.getState().turn.phase).toBe('idle')
        expect(isBusy(h.store.getState().turn)).toBe(false)
      }),
      { numRuns: 20 },
    )
  })

  it('a rejected send always releases the composer and restores the message', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('boom', ''), async (message) => {
        const h = makeHarness(['ok'])
        const client = {
          sendMessage: vi.fn(async () => {
            throw new Error(message)
          }),
        }
        const actions = createConversationActions(h.store, client)
        h.store.getState().set({ sessionId: SESSIONS[0], composerText: 'question' })
        await actions.send('gpt-5.5')

        expect(h.store.getState().turn.phase).toBe('idle')
        expect(isBusy(h.store.getState().turn)).toBe(false)
        expect(h.store.getState().composerText).toBe('question')
        expect(h.store.getState().composerError).toBeTruthy()
        expect(h.store.getState().pendingUser).toBeNull()
      }),
      { numRuns: 10 },
    )
  })
})
