import { describe, expect, it, vi } from 'vitest'

import { canStop } from '../../shared/turn/turn-machine'
import {
  createConversationActions,
  type CommandTurnResult,
  type ConversationActionsClient,
} from './conversation-actions'
import { createConversationStore } from './conversation-store'

const turnResult = (over?: Partial<CommandTurnResult>): CommandTurnResult => ({
  sessionId: 'sess-1',
  turnId: 'turn-1',
  ...over,
})

function setup(over?: Partial<ConversationActionsClient>) {
  const stopTurn = vi.fn(async (): Promise<boolean> => true)
  const store = createConversationStore({
    transport: { stopTurn },
    initial: { sessionId: 'sess-1', composerText: 'how does this work?' },
  })
  const client: ConversationActionsClient = {
    sendMessage: vi.fn(async () => turnResult()),
    ...over,
  }
  return { store, client, stopTurn, actions: createConversationActions(store, client) }
}

describe('createConversationActions — send', () => {
  it('adopts the turnId from the command result, so Stop is reachable before the first token', async () => {
    const { store, client, actions } = setup()
    await actions.send('gpt-5.5')

    expect(client.sendMessage).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      message: 'how does this work?',
      modelId: 'gpt-5.5',
      attachmentIds: [],
    })
    // No transcript.delta has arrived yet — the identity came from the result.
    expect(store.getState().answer).toBe('')
    expect(store.getState().turn.scope.turnId).toBe('turn-1')
    expect(canStop(store.getState().turn)).toBe(true)
  })

  it('shows the optimistic bubble and clears the composer', async () => {
    const { store, actions } = setup()
    await actions.send('gpt-5.5')
    expect(store.getState().composerText).toBe('')
    expect(store.getState().pendingUser?.content).toBe('how does this work?')
    expect(store.getState().pendingUser?.sessionId).toBe('sess-1')
  })

  it('rolls the bubble back, restores the composer, and releases it on rejection', async () => {
    const { store, actions } = setup({
      sendMessage: vi.fn(async () => {
        throw new Error('Server unavailable')
      }),
    })
    await actions.send('gpt-5.5')

    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().pendingUser).toBeNull()
    expect(store.getState().composerText).toBe('how does this work?')
    expect(store.getState().composerError).toBe('Server unavailable')
  })

  it('keeps a newly-typed composer value instead of restoring the failed message', async () => {
    const { store, actions } = setup({
      sendMessage: vi.fn(async () => {
        store.getState().set({ composerText: 'something else' })
        throw new Error('nope')
      }),
    })
    await actions.send('gpt-5.5')
    expect(store.getState().composerText).toBe('something else')
  })

  it('guards a blank composer, a missing session, and an already-active turn', async () => {
    const blank = setup()
    blank.store.getState().set({ composerText: '   ' })
    await blank.actions.send('gpt-5.5')
    expect(blank.client.sendMessage).not.toHaveBeenCalled()

    const noSession = setup()
    noSession.store.getState().set({ sessionId: null })
    await noSession.actions.send('gpt-5.5')
    expect(noSession.client.sendMessage).not.toHaveBeenCalled()

    const busy = setup()
    busy.store.getState().dispatch({ type: 'initiate', kind: 'chat', sessionId: 'sess-1' })
    await busy.actions.send('gpt-5.5')
    expect(busy.client.sendMessage).not.toHaveBeenCalled()
  })
})

describe('createConversationActions — stop', () => {
  it('stops the adopted turn during the thinking phase', async () => {
    const { store, actions, stopTurn } = setup()
    await actions.send('gpt-5.5')
    actions.stop()
    expect(stopTurn).toHaveBeenCalledWith('turn-1')
    expect(store.getState().turn.stopInFlight).toBe(true)
  })

  it('is a no-op when nothing is running', () => {
    const { actions, stopTurn } = setup()
    actions.stop()
    expect(stopTurn).not.toHaveBeenCalled()
  })
})
