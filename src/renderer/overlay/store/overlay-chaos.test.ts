import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FRESH_SESSION_ID, FRESH_TURN_ID, turnInputArb } from '../../shared/turn/arbitraries'
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
import type { Attachment } from '../types'
import { MAX_ATTACHMENTS } from './contract'
import { createOverlayStore } from './overlay-store'

/**
 * Chaos / property suite for the OVERLAY store — the layer where the shared
 * machine's effects meet the real transport and the overlay's own
 * reconciliation buffers (transcript, tool activities, screenshot queue).
 *
 * `shared/turn/chaos.test.ts` covers the pure reducer; this adds the guarantees
 * that only exist once the store interprets it: the overlay can never be stuck
 * busy, a refused event never grows a buffer, and the queue's caps and removal
 * memory survive any interleaving.
 */

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

type StopOutcome = 'ok' | 'refused' | 'throws'

async function settlePromises(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

function makeStore(outcomes: readonly StopOutcome[]) {
  let call = 0
  const stopTurn = vi.fn(async (): Promise<boolean> => {
    const outcome = outcomes[call++ % outcomes.length]
    if (outcome === 'throws') throw new Error('stop transport exploded')
    return outcome === 'ok'
  })
  return { store: createOverlayStore({ transport: { stopTurn } }), stopTurn }
}

const settleIdentity = (turn: TurnState) => ({
  sessionId: turn.scope.sessionId ?? FRESH_SESSION_ID,
  turnId: turn.scope.turnId ?? FRESH_TURN_ID,
})

/** The busy/Stop guarantees, asserted on the store's live turn state. */
function checkTurnInvariants(turn: TurnState, label: string): void {
  const at = (msg: string) => `${label}: ${msg}`
  expect(turn.ignoredTurnIds.length, at('ignoredTurnIds cap')).toBeLessThanOrEqual(
    MAX_IGNORED_TURN_IDS,
  )
  if (turn.phase === 'idle') {
    expect(turn, at('idle state fully reset')).toEqual({
      ...IDLE_TURN,
      ignoredTurnIds: turn.ignoredTurnIds,
    })
    return
  }
  const id = settleIdentity(turn)
  const pending: TurnInput[] = turn.stopInFlight ? [{ type: 'stopSettled', ok: true }] : []
  expect(
    driveWithStops(turn, [
      ...pending,
      { type: 'commandSettled', ...id },
      { type: 'terminal', ...id, outcome: 'complete' },
    ]).phase,
    at('a settled command + its terminal release the overlay'),
  ).toBe('idle')
  if (!turn.terminal && !turn.dismissed && !canStop(turn)) {
    expect(turn.scope.turnId, at('only an unknown turnId can block Stop')).toBeUndefined()
    expect(
      canStop(reduceTurn(turn, { type: 'commandSettled', ...id }).state),
      at('the command result makes Stop reachable'),
    ).toBe(true)
  }
}

/** A step is either a machine input or one of the overlay's own mutations. */
type Step =
  | { kind: 'input'; input: TurnInput }
  | { kind: 'delta'; sessionId: string; turnId: string; text: string }
  | { kind: 'tool'; sessionId: string; turnId: string; activityId: string }
  | { kind: 'capture'; id: string }
  | { kind: 'remove'; id: string }
  | { kind: 'clearQueue' }
  | { kind: 'loadQueue'; ids: string[] }

const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f')

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  turnInputArb().map((input) => ({ kind: 'input' as const, input })),
  fc.record({
    kind: fc.constant('delta' as const),
    sessionId: fc.constantFrom('s1', 's2'),
    turnId: fc.constantFrom('t0', 't1', 't2'),
    text: fc.constantFrom('x', 'yy'),
  }),
  fc.record({
    kind: fc.constant('tool' as const),
    sessionId: fc.constantFrom('s1', 's2'),
    turnId: fc.constantFrom('t0', 't1', 't2'),
    activityId: fc.constantFrom('act-1', 'act-2'),
  }),
  fc.record({ kind: fc.constant('capture' as const), id: idArb }),
  fc.record({ kind: fc.constant('remove' as const), id: idArb }),
  fc.record({ kind: fc.constant('clearQueue' as const) }),
  fc.record({ kind: fc.constant('loadQueue' as const), ids: fc.array(idArb, { maxLength: 8 }) }),
)

const attachment = (id: string): Attachment => ({ id, name: `${id}.png`, preview: `data:${id}` })

describe('property — the overlay store survives arbitrary interleavings', () => {
  it('never wedges busy, and never applies a refused event to a buffer', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { maxLength: 20 }),
        fc.array(fc.constantFrom<StopOutcome>('ok', 'refused', 'throws'), {
          minLength: 1,
          maxLength: 3,
        }),
        async (steps, outcomes) => {
          const { store } = makeStore(outcomes)
          const s = () => store.getState()

          for (const [index, step] of steps.entries()) {
            const label = `step ${index} (${step.kind})`
            const before = s()
            const turnBefore = before.turn

            switch (step.kind) {
              case 'input':
                s().dispatch(step.input)
                break

              case 'delta': {
                // Mirrors useProductEventBridge: dispatch, apply only if accepted.
                const { accepted } = s().dispatch({
                  type: 'streamEvent',
                  sessionId: step.sessionId,
                  turnId: step.turnId,
                })
                if (
                  turnBefore.phase === 'idle' ||
                  turnBefore.ignoredTurnIds.includes(step.turnId)
                ) {
                  expect(accepted, `${label}: quarantined turn accepted a delta`).toBe(false)
                }
                if (accepted) s().appendTranscript({ answer: step.text })
                s().flushTranscript()
                if (!accepted) {
                  expect(s().answer, `${label}: answer grew on a refused event`).toBe(before.answer)
                }
                break
              }

              case 'tool': {
                const { accepted } = s().dispatch({
                  type: 'streamEvent',
                  sessionId: step.sessionId,
                  turnId: step.turnId,
                })
                if (accepted) {
                  s().applyToolStatus({
                    activityId: step.activityId,
                    name: 'shell',
                    state: 'running',
                  })
                  s().applyToolOutput({ activityId: step.activityId, text: 'out' })
                } else {
                  expect(s().activities, `${label}: activities grew on a refused event`).toEqual(
                    before.activities,
                  )
                }
                break
              }

              case 'capture':
                s().addAttachment(attachment(step.id))
                break

              case 'remove':
                s().removeAttachment(step.id)
                expect(
                  s().attachments.some((item) => item.id === step.id),
                  `${label}: removed attachment survived`,
                ).toBe(false)
                break

              case 'clearQueue':
                s().clearAttachments()
                expect(s().attachments, `${label}: queue not cleared`).toEqual([])
                break

              case 'loadQueue':
                s().mergeLoadedAttachments(step.ids.map(attachment))
                break
            }

            await settlePromises()
            checkTurnInvariants(s().turn, label)
            expect(s().attachments.length, `${label}: attachment cap`).toBeLessThanOrEqual(
              MAX_ATTACHMENTS,
            )
            expect(
              new Set(s().attachments.map((item) => item.id)).size,
              `${label}: duplicate attachment ids`,
            ).toBe(s().attachments.length)
            expect(
              new Set(s().activities.map((item) => item.key)).size,
              `${label}: duplicate activity keys`,
            ).toBe(s().activities.length)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('a removed screenshot is never resurrected by a late bulk load', async () => {
    await fc.assert(
      fc.asyncProperty(
        idArb,
        fc.array(idArb, { minLength: 1, maxLength: 6 }),
        async (removed, loaded) => {
          const { store } = makeStore(['ok'])
          store.getState().addAttachment(attachment(removed))
          store.getState().removeAttachment(removed)
          store.getState().mergeLoadedAttachments(loaded.map(attachment))
          expect(store.getState().attachments.some((item) => item.id === removed)).toBe(false)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('a failed stop always leaves the overlay showing the live turn again', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'solve' | 'chat'>('solve', 'chat'),
        fc.constantFrom<StopOutcome>('refused', 'throws'),
        async (kind, outcome) => {
          const { store } = makeStore([outcome])
          const s = () => store.getState()
          s().dispatch({ type: 'initiate', kind })
          s().dispatch({ type: 'started', kind, sessionId: 's1', turnId: 't1' })
          s().dispatch({ type: 'commandSettled', sessionId: 's1', turnId: 't1' })
          s().dispatch({ type: 'dismiss' })
          await settlePromises()

          // The turn could not be stopped, so it is revived: still busy, still
          // stoppable, and the panel the user was reading is back on screen.
          expect(isBusy(s().turn)).toBe(true)
          expect(canStop(s().turn)).toBe(true)
          expect(s().view).toBe(kind === 'chat' ? 'chat' : 'solution')
          expect(s().visibleError).toBeTruthy()

          // …and the real terminal event for the settled turn still releases it.
          s().dispatch({ type: 'terminal', sessionId: 's1', turnId: 't1', outcome: 'complete' })
          expect(isBusy(s().turn)).toBe(false)
        },
      ),
      { numRuns: 8 },
    )
  })
})
