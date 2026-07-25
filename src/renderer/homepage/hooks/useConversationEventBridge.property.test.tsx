// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: Record<string, unknown>) => void) | undefined,
  transcriptSnapshot: vi.fn(),
}))

vi.mock('../../desktop', () => ({
  desktopClient: {
    available: true,
    onProductEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      mocks.listener = listener
      return () => {
        if (mocks.listener === listener) mocks.listener = undefined
      }
    }),
    transcriptSnapshot: mocks.transcriptSnapshot,
  },
}))

import { createConversationStore } from '../store/conversation-store'
import { useConversationEventBridge } from './useConversationEventBridge'

/**
 * Property coverage for the bridge's ORIGIN filter — the guard that keeps an
 * overlay conversation out of the History page. A turn started from the overlay
 * streams into that window; if any of its events reached this store the page
 * would show a phantom streaming bubble, and its terminal event would release a
 * composer that never sent anything.
 *
 * The filter is stated as a property because it has to hold for EVERY event
 * shape on the channel, not just the deltas a hand-written test remembers.
 */

beforeEach(() => {
  mocks.transcriptSnapshot.mockResolvedValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  mocks.listener = undefined
  mocks.transcriptSnapshot.mockReset()
  vi.restoreAllMocks()
})

const TRANSCRIPT_TYPES = [
  'transcript.delta',
  'transcript.reasoning',
  'transcript.complete',
  'transcript.failed',
  'transcript.gap',
] as const

/** Any event the main process can fan out, with a NON-homepage origin. */
const foreignEventArb = fc.record({
  type: fc.constantFrom(...TRANSCRIPT_TYPES),
  // 'overlay' is the real other surface; the unknown value guards the filter
  // against a future origin being treated as ours by default.
  origin: fc.constantFrom('overlay', 'unknown-surface'),
  // Deliberately includes the very session and turn this store owns.
  sessionId: fc.constantFrom('sess-1', 'sess-2'),
  turnId: fc.constantFrom('turn-1', 'overlay-turn'),
  text: fc.constantFrom('leak', ''),
  message: fc.constant('overlay failed'),
  sequence: fc.integer({ min: 1, max: 8 }),
  evictedThrough: fc.integer({ min: 0, max: 8 }),
  droppedCount: fc.integer({ min: 1, max: 4 }),
})

function setup() {
  const onTurnEnded = vi.fn()
  const store = createConversationStore({
    transport: { stopTurn: vi.fn(async () => true) },
    onTurnEnded,
    initial: { sessionId: 'sess-1' },
  })
  renderHook(() => useConversationEventBridge(store))
  return {
    store,
    onTurnEnded,
    emit: (event: Record<string, unknown>) => mocks.listener?.(event),
  }
}

describe('property — the History bridge ignores every non-homepage event', () => {
  it('leaves the turn, the transcript, and the composer untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(foreignEventArb, { maxLength: 10 }),
        fc.boolean(),
        async (events, withActiveTurn) => {
          const { store, emit, onTurnEnded } = setup()
          if (withActiveTurn) {
            // The dangerous case: this page has its OWN live turn whose id and
            // session collide with the overlay traffic.
            store.getState().dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
            store
              .getState()
              .dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })
          }
          const before = store.getState()
          const snapshot = {
            turn: before.turn,
            answer: before.answer,
            reasoning: before.reasoning,
            composerError: before.composerError,
            pendingUser: before.pendingUser,
          }

          for (const event of events) emit(event)
          store.getState().flushTranscript()

          const after = store.getState()
          expect(after.turn).toEqual(snapshot.turn)
          expect(after.answer).toBe(snapshot.answer)
          expect(after.reasoning).toBe(snapshot.reasoning)
          expect(after.composerError).toBe(snapshot.composerError)
          expect(after.pendingUser).toBe(snapshot.pendingUser)
          expect(onTurnEnded).not.toHaveBeenCalled()
          // A foreign turn must not even be probed for a transcript snapshot.
          expect(mocks.transcriptSnapshot).not.toHaveBeenCalled()
          cleanup()
        },
      ),
      { numRuns: 60 },
    )
  })

  it('still applies the identical events when they carry the homepage origin', () => {
    const { store, emit } = setup()
    store.getState().dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    store.getState().dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })

    // The control case that proves the property above is not vacuous.
    emit({
      type: 'transcript.delta',
      origin: 'homepage',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      sequence: 1,
      text: 'applied',
    })
    store.getState().flushTranscript()
    expect(store.getState().answer).toBe('applied')

    emit({
      type: 'transcript.complete',
      origin: 'homepage',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      sequence: 2,
    })
    expect(store.getState().turn.phase).toBe('idle')
  })
})
