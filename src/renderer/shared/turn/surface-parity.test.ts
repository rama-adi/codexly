import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConversationStore } from '../../homepage/store/conversation-store'
import { createOverlayStore } from '../../overlay/store/overlay-store'
import { turnInputsArb } from './arbitraries'
import { runInputs } from './harness'
import { canStop, isBusy, isStreaming, type TurnInput, type TurnResult } from './turn-machine'

/**
 * Divergence guard for the two surfaces that host the shared turn machine.
 *
 * The overlay and the History page were unified onto one reducer; the risk of
 * that extraction is a subtle FORK — one store interpreting an effect slightly
 * differently, or its own bookkeeping (the overlay's view switch, the homepage's
 * refetch notification) feeding back into the machine and desynchronising the
 * two. This suite drives both real stores with the identical input sequence and
 * the identical stop-transport outcomes, and requires them to agree on the turn
 * state, the acceptance verdicts, and the stop requests at every step.
 */

// Both stores log every reported error; the adversarial runs would drown the
// reporter in it.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

type StopOutcome = 'ok' | 'refused' | 'throws'

/** Let the stopTurn promise chain (and its stopSettled dispatch) run. */
async function settlePromises(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

function makeTransport(outcomes: readonly StopOutcome[]) {
  let call = 0
  const ids: string[] = []
  const stopTurn = vi.fn(async (turnId: string): Promise<boolean> => {
    ids.push(turnId)
    const outcome = outcomes[call++ % outcomes.length]
    if (outcome === 'throws') throw new Error('stop transport exploded')
    return outcome === 'ok'
  })
  return { transport: { stopTurn }, ids }
}

/** The full observable turn verdict for one dispatch, minus surface specifics. */
const verdict = (result: TurnResult) => ({
  state: result.state,
  effects: result.effects,
  accepted: result.accepted,
  freshStart: result.freshStart,
})

const stopOutcomesArb = fc.array(fc.constantFrom<StopOutcome>('ok', 'refused', 'throws'), {
  minLength: 1,
  maxLength: 3,
})

describe('property — the overlay and the History page never diverge', () => {
  it('both surfaces reach the same turn state for the same event sequence', async () => {
    // Coverage sanity: the sequences must actually exercise the stop transport,
    // otherwise the parity claim would be vacuous.
    let stopsObserved = 0
    await fc.assert(
      fc.asyncProperty(
        turnInputsArb({ maxLength: 18 }),
        stopOutcomesArb,
        async (inputs, outcomes) => {
          const overlaySide = makeTransport(outcomes)
          const homeSide = makeTransport(outcomes)
          const overlay = createOverlayStore({ transport: overlaySide.transport })
          const homepage = createConversationStore({
            transport: homeSide.transport,
            onTurnEnded: vi.fn(),
            initial: { sessionId: 's1' },
          })

          for (const [index, input] of inputs.entries()) {
            const a = verdict(overlay.getState().dispatch(input))
            const b = verdict(homepage.getState().dispatch(input))
            expect(b, `step ${index} (${input.type}): dispatch verdicts diverged`).toEqual(a)
            await settlePromises()
            expect(
              homepage.getState().turn,
              `step ${index} (${input.type}): turn state diverged after effects settled`,
            ).toEqual(overlay.getState().turn)
          }

          // Identical stop requests, in identical order.
          expect(homeSide.ids).toEqual(overlaySide.ids)
          stopsObserved += overlaySide.ids.length
        },
      ),
      { numRuns: 150 },
    )
    expect(stopsObserved).toBeGreaterThan(0)
  })

  it('both surfaces derive the same UI flags, and they match the pure reducer', async () => {
    await fc.assert(
      fc.asyncProperty(turnInputsArb({ maxLength: 18 }), async (inputs) => {
        const overlay = createOverlayStore({ transport: makeTransport(['ok']).transport })
        const homepage = createConversationStore({
          transport: makeTransport(['ok']).transport,
          initial: { sessionId: 's1' },
        })
        for (const input of inputs) {
          overlay.getState().dispatch(input)
          homepage.getState().dispatch(input)
          await settlePromises()
        }
        const a = overlay.getState().turn
        const b = homepage.getState().turn
        for (const selector of [isBusy, isStreaming, canStop]) {
          expect(selector(b)).toBe(selector(a))
        }
        // Neither store's own bookkeeping perturbs the machine: folding the same
        // inputs purely (no transport at all) reaches the same place, as long as
        // the sequence needed no stop acknowledgement.
        if (!a.stopInFlight && !inputs.some((i) => i.type === 'dismiss' || i.type === 'reset')) {
          expect(a).toEqual(runInputs(inputs).state)
        }
      }),
      { numRuns: 120 },
    )
  })

  it('a released composer on one surface means a released overlay on the other', async () => {
    await fc.assert(
      fc.asyncProperty(
        turnInputsArb({ maxLength: 12 }),
        stopOutcomesArb,
        async (inputs, outcomes) => {
          const overlay = createOverlayStore({ transport: makeTransport(outcomes).transport })
          const homepage = createConversationStore({
            transport: makeTransport(outcomes).transport,
            initial: { sessionId: 's1' },
          })
          const release: TurnInput[] = [{ type: 'commandFailed' }]
          for (const input of [...inputs, ...release]) {
            overlay.getState().dispatch(input)
            homepage.getState().dispatch(input)
            await settlePromises()
          }
          expect(isBusy(overlay.getState().turn)).toBe(false)
          expect(isBusy(homepage.getState().turn)).toBe(false)
        },
      ),
      { numRuns: 80 },
    )
  })
})
