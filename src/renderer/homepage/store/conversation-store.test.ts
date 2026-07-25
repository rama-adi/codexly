import { describe, expect, it, vi } from 'vitest'

import { createConversationStore } from './conversation-store'
import type { ConversationTransport, PendingUserMessage } from './contract'

/** Flush pending microtasks/promise callbacks (transport is async). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeStore(transport?: Partial<ConversationTransport>) {
  const stopTurn = vi.fn(async (): Promise<boolean> => true)
  const onTurnEnded = vi.fn()
  const store = createConversationStore({
    transport: { stopTurn, ...transport },
    onTurnEnded,
    initial: { sessionId: 'sess-1' },
  })
  return { store, stopTurn, onTurnEnded }
}

const pending = (sessionId: string): PendingUserMessage => ({
  id: 'pending-1',
  sessionId,
  content: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('createConversationStore — turn dispatch / effects', () => {
  it('interprets a stopTurn effect when the user stops mid-stream', async () => {
    const { store, stopTurn } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    s.dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })
    expect(store.getState().turn.phase).toBe('active')

    s.dispatch({ type: 'dismiss' })
    expect(stopTurn).toHaveBeenCalledWith('turn-1')

    await tick()
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().turn.stopInFlight).toBe(false)
  })

  it('surfaces a composer error and releases the composer when the stop fails', async () => {
    const { store } = makeStore({ stopTurn: vi.fn(async () => false) })
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    s.dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })
    s.dispatch({ type: 'dismiss' })
    await tick()

    // The machine revived the still-running turn, so the stream is still shown…
    expect(store.getState().turn.phase).toBe('active')
    expect(store.getState().turn.dismissed).toBe(false)
    expect(store.getState().composerError).toMatch(/could not be stopped/i)

    // …and the terminal event still releases everything.
    s.dispatch({ type: 'terminal', sessionId: 'sess-1', turnId: 'turn-1', outcome: 'complete' })
    expect(store.getState().turn.phase).toBe('idle')
  })

  it('releases the composer on commandFailed without asking for a refetch', () => {
    const { store, onTurnEnded } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    // No terminal event will ever arrive for this turn — the rejected command is
    // the only thing that ends it.
    s.dispatch({ type: 'commandFailed' })

    expect(store.getState().turn.phase).toBe('idle')
    expect(onTurnEnded).not.toHaveBeenCalled()
  })

  it('drops the optimistic bubble and asks for a refetch when the turn ends', () => {
    const { store, onTurnEnded } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    s.set({ pendingUser: pending('sess-1') })
    s.dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })
    expect(store.getState().pendingUser).not.toBeNull()

    s.dispatch({ type: 'terminal', sessionId: 'sess-1', turnId: 'turn-1', outcome: 'complete' })
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().pendingUser).toBeNull()
    expect(onTurnEnded).toHaveBeenCalledWith('sess-1')
  })

  it('ignores a foreign session even when the event reaches dispatch', () => {
    const { store } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    const other = s.dispatch({ type: 'streamEvent', sessionId: 'sess-2', turnId: 'turn-9' })
    expect(other.accepted).toBe(false)

    // …and a terminal for that other session cannot release this composer.
    const terminal = s.dispatch({
      type: 'terminal',
      sessionId: 'sess-2',
      turnId: 'turn-9',
      outcome: 'complete',
    })
    expect(terminal.accepted).toBe(false)
    expect(store.getState().turn.phase).toBe('active')
  })
})

describe('createConversationStore — selectSession', () => {
  it('abandons an in-flight turn without stopping it and quarantines its events', () => {
    const { store, stopTurn, onTurnEnded } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    s.dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-1' })
    s.set({ pendingUser: pending('sess-1') })
    s.appendTranscript({ answer: 'partial' })
    s.flushTranscript()

    s.selectSession('sess-2')

    // The background turn keeps running so its answer still persists.
    expect(stopTurn).not.toHaveBeenCalled()
    expect(onTurnEnded).not.toHaveBeenCalled()
    expect(store.getState().sessionId).toBe('sess-2')
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().answer).toBe('')
    expect(store.getState().pendingUser).toBeNull()

    // Its late events can never leak into the newly-selected conversation.
    expect(
      store.getState().dispatch({ type: 'streamEvent', sessionId: 'sess-1', turnId: 'turn-1' })
        .accepted,
    ).toBe(false)
  })

  it('is a no-op when the same session is re-selected', () => {
    const { store } = makeStore()
    store.getState().set({ composerError: 'boom' })
    store.getState().selectSession('sess-1')
    expect(store.getState().composerError).toBe('boom')
  })
})

describe('createConversationStore — transcript batching', () => {
  it('accumulates via appendTranscript + flushTranscript and clears via resetTranscript', () => {
    const { store } = makeStore()
    const s = store.getState()

    s.appendTranscript({ answer: 'Hel' })
    s.appendTranscript({ answer: 'lo', reasoning: 'because' })
    s.flushTranscript()

    expect(store.getState().answer).toBe('Hello')
    expect(store.getState().reasoning).toBe('because')

    s.set({ thinkingExpanded: false, streamPhase: 'answering' })
    s.resetTranscript()
    expect(store.getState().answer).toBe('')
    expect(store.getState().reasoning).toBe('')
    expect(store.getState().streamPhase).toBe('reasoning')
    expect(store.getState().thinkingExpanded).toBe(true)
  })
})
