// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  mocks.listener = undefined
  mocks.transcriptSnapshot.mockReset()
  vi.clearAllMocks()
})

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    turnId: 'turn-1',
    sessionId: 'sess-1',
    origin: 'homepage' as const,
    sequence: 5,
    answer: 'complete answer',
    reasoning: 'complete reasoning',
    toolOutputs: [],
    live: true,
    ...overrides,
  }
}

function setup() {
  const onTurnEnded = vi.fn()
  const store = createConversationStore({
    transport: { stopTurn: vi.fn(async () => true) },
    onTurnEnded,
    initial: { sessionId: 'sess-1' },
  })
  renderHook(() => useConversationEventBridge(store))
  const emit = (event: Record<string, unknown>) => mocks.listener?.(event)
  return { store, emit, onTurnEnded }
}

/** Put the store's machine in the state produced by a settled homepage send. */
function startTurn(store: ReturnType<typeof setup>['store']) {
  store.getState().dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
  store.getState().dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })
}

describe('useConversationEventBridge — origin filtering', () => {
  it('ignores an overlay-driven stream for the very same session', () => {
    const { store, emit, onTurnEnded } = setup()

    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'overlay-turn',
      origin: 'overlay',
      text: 'from the overlay',
    })
    // No phantom streaming bubble: neither a turn nor any transcript appeared.
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().answer).toBe('')

    // And the overlay turn's terminal event must not touch this composer.
    startTurn(store)
    emit({
      type: 'transcript.complete',
      sessionId: 'sess-1',
      turnId: 'overlay-turn',
      origin: 'overlay',
    })
    expect(store.getState().turn.phase).toBe('active')
    expect(onTurnEnded).not.toHaveBeenCalled()
  })
})

describe('useConversationEventBridge — homepage stream', () => {
  it('applies reasoning then answer chunks and toggles the Thinking disclosure per phase', () => {
    const { store, emit } = setup()
    startTurn(store)

    emit({
      type: 'transcript.reasoning',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      text: 'weighing options',
    })
    store.getState().flushTranscript()
    expect(store.getState().reasoning).toBe('weighing options')
    expect(store.getState().thinkingExpanded).toBe(true)

    // A manual collapse survives further chunks of the same phase.
    store.getState().set({ thinkingExpanded: false })
    emit({
      type: 'transcript.reasoning',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      text: ' more',
    })
    expect(store.getState().thinkingExpanded).toBe(false)

    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      text: 'Here you go.',
    })
    store.getState().flushTranscript()
    expect(store.getState().answer).toBe('Here you go.')
    expect(store.getState().streamPhase).toBe('answering')
  })

  it('releases the composer and requests a refetch on completion', () => {
    const { store, emit, onTurnEnded } = setup()
    startTurn(store)

    emit({
      type: 'transcript.complete',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
    })
    expect(store.getState().turn.phase).toBe('idle')
    expect(onTurnEnded).toHaveBeenCalledWith('sess-1')
  })

  it('releases the composer and shows the reason on failure', () => {
    const { store, emit } = setup()
    startTurn(store)

    emit({
      type: 'transcript.failed',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      message: 'Codex hung up.',
    })
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().composerError).toBe('Codex hung up.')
  })

  it('ignores a homepage stream for a different session', () => {
    const { store, emit } = setup()
    startTurn(store)

    emit({
      type: 'transcript.delta',
      sessionId: 'sess-2',
      turnId: 'turn-2',
      origin: 'homepage',
      text: 'elsewhere',
    })
    store.getState().flushTranscript()
    expect(store.getState().answer).toBe('')
  })
})

describe('useConversationEventBridge — gap recovery', () => {
  it('replaces the transcript from the snapshot when a delta is missing', async () => {
    mocks.transcriptSnapshot.mockResolvedValue(snapshot())
    const { store, emit } = setup()
    startTurn(store)

    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 1,
      text: 'first ',
    })
    // Sequences 2-4 never arrived, so appending 'tail' would produce a
    // plausible-looking transcript with a hole in the middle.
    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 5,
      text: 'tail',
    })
    await vi.waitFor(() => expect(store.getState().answer).toBe('complete answer'))
    expect(store.getState().reasoning).toBe('complete reasoning')
    expect(mocks.transcriptSnapshot).toHaveBeenCalledWith('turn-1')

    // Application resumes from the snapshot's sequence.
    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 6,
      text: ' and more',
    })
    store.getState().flushTranscript()
    expect(store.getState().answer).toBe('complete answer and more')
  })

  it('recovers from an explicit transport gap marker', async () => {
    mocks.transcriptSnapshot.mockResolvedValue(snapshot({ sequence: 9 }))
    const { store, emit } = setup()
    startTurn(store)

    emit({
      type: 'transcript.gap',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      evictedThrough: 8,
      droppedCount: 4,
    })
    await vi.waitFor(() => expect(store.getState().answer).toBe('complete answer'))
  })

  it('ignores a replayed delta instead of duplicating its text', () => {
    const { store, emit } = setup()
    startTurn(store)

    for (const sequence of [1, 1, 2]) {
      emit({
        type: 'transcript.delta',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        origin: 'homepage',
        sequence,
        text: sequence === 1 ? 'one' : ' two',
      })
    }
    store.getState().flushTranscript()
    expect(store.getState().answer).toBe('one two')
    expect(mocks.transcriptSnapshot).not.toHaveBeenCalled()
  })

  it('settles the turn only after a gap detected on the terminal event is repaired', async () => {
    mocks.transcriptSnapshot.mockResolvedValue(snapshot({ sequence: 6, live: false }))
    const { store, emit, onTurnEnded } = setup()
    startTurn(store)

    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 1,
      text: 'partial',
    })
    emit({
      type: 'transcript.complete',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 6,
    })
    // The terminal event is deferred, never dropped: the composer is released
    // once the authoritative transcript has been restored.
    expect(store.getState().turn.phase).toBe('active')
    await vi.waitFor(() => expect(store.getState().turn.phase).toBe('idle'))
    expect(store.getState().answer).toBe('complete answer')
    expect(onTurnEnded).toHaveBeenCalledWith('sess-1')
  })

  it('keeps the local transcript when the main process no longer knows the turn', async () => {
    mocks.transcriptSnapshot.mockResolvedValue(null)
    const { store, emit } = setup()
    startTurn(store)

    emit({
      type: 'transcript.delta',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 4,
      text: 'all we have',
    })
    await vi.waitFor(() => expect(mocks.transcriptSnapshot).toHaveBeenCalled())
    store.getState().flushTranscript()
    expect(store.getState().answer).toBe('')

    emit({
      type: 'transcript.complete',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'homepage',
      sequence: 5,
    })
    await vi.waitFor(() => expect(store.getState().turn.phase).toBe('idle'))
  })
})
