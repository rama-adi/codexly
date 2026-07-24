import { describe, expect, it, vi } from 'vitest'

import { createOverlayStore } from '../store/overlay-store'
import type { Attachment } from '../types'
import {
  createOverlayActions,
  type CommandTurnResult,
  type OverlayActionsClient,
} from './overlay-actions'

const attachment =(id: string): Attachment => ({ id, name: `${id}.png`, preview: `data:${id}` })

const turnResult = (over?: Partial<CommandTurnResult>): CommandTurnResult => ({
  sessionId: 'sess-1',
  turnId: 'turn-1',
  ...over,
})

function makeClient(over?: Partial<OverlayActionsClient>): OverlayActionsClient {
  return {
    capture: vi.fn(async () => undefined),
    captureSelection: vi.fn(async () => undefined),
    solvePending: vi.fn(async () => turnResult()),
    sendMessage: vi.fn(async () => turnResult()),
    clearAttachments: vi.fn(async () => undefined),
    discardAttachment: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({ id: 'new-session' })),
    openHome: vi.fn(async () => undefined),
    toggleOverlay: vi.fn(async () => undefined),
    ...over,
  }
}

function setup(over?: Partial<OverlayActionsClient>, initial?: Parameters<typeof createOverlayStore>[0]['initial']) {
  const stopTurn = vi.fn(async (): Promise<boolean> => true)
  const store = createOverlayStore({ transport: { stopTurn }, initial })
  const client = makeClient(over)
  const actions = createOverlayActions(store, client)
  return { store, client, actions, stopTurn }
}

describe('createOverlayActions — solve', () => {
  it('is a no-op with an empty queue', async () => {
    const { store, client, actions } = setup()
    await actions.solve()
    expect(client.solvePending).not.toHaveBeenCalled()
    expect(store.getState().turn.phase).toBe('idle')
  })

  it('dispatches initiate then commandSettled on success', async () => {
    const { store, client, actions } = setup({}, { attachments: [attachment('a1')] })
    await actions.solve()
    expect(client.solvePending).toHaveBeenCalledWith(store.getState().modelId)
    expect(store.getState().view).toBe('solution')
    // commandSettled reconciled the turn back to idle (no stream events yet,
    // command matched the local scope).
    expect(store.getState().turn.commandSettled).toBe(true)
  })

  it('dispatches commandFailed and shows the queue + error on failure', async () => {
    const { store, actions } = setup(
      { solvePending: vi.fn(async () => { throw new Error('boom') }) },
      { attachments: [attachment('a1')] },
    )
    await actions.solve()
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().view).toBe('queue')
    expect(store.getState().visibleError).toBe('boom')
  })

  it('does not start a second solve while a turn is active', async () => {
    const { store, client, actions } = setup(
      { solvePending: vi.fn(() => new Promise<CommandTurnResult>(() => {})) },
      { attachments: [attachment('a1')] },
    )
    void actions.solve()
    await actions.solve()
    expect(client.solvePending).toHaveBeenCalledTimes(1)
    expect(store.getState().turn.phase).toBe('active')
  })
})

describe('createOverlayActions — sendChat', () => {
  it('appends the user message and clears the input', async () => {
    const { store, actions } = setup({}, { chatInput: 'hello' })
    await actions.sendChat('hello')
    expect(store.getState().messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(store.getState().chatInput).toBe('')
  })

  it('is a no-op for an empty message', async () => {
    const { store, client, actions } = setup()
    await actions.sendChat('')
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(store.getState().messages).toEqual([])
  })

  it('restores chatInput and removes the optimistic message on failure', async () => {
    const { store, actions } = setup({
      sendMessage: vi.fn(async () => { throw new Error('offline') }),
    })
    await actions.sendChat('are you there')
    expect(store.getState().messages).toEqual([])
    expect(store.getState().chatInput).toBe('are you there')
    expect(store.getState().streamError).toBe('Message was not sent: offline')
    expect(store.getState().visibleError).toBe('offline')
  })

  it('forwards session id and attachment ids', async () => {
    const { client, actions } = setup(
      {},
      { sessionId: 'sess-42', attachments: [attachment('a1'), attachment('a2')] },
    )
    await actions.sendChat('ship it')
    expect(client.sendMessage).toHaveBeenCalledWith({
      sessionId: 'sess-42',
      message: 'ship it',
      modelId: expect.any(String),
      attachmentIds: ['a1', 'a2'],
    })
  })
})

describe('createOverlayActions — clear / reset guards', () => {
  it('clear is blocked while a turn is active', async () => {
    const { store, client, actions } = setup()
    store.getState().dispatch({ type: 'initiate', kind: 'chat' })
    const result = await actions.clear()
    expect(result).toBe(false)
    expect(client.clearAttachments).not.toHaveBeenCalled()
  })

  it('clear resets the queue view + attachments when idle', async () => {
    const { store, client, actions } = setup({}, { attachments: [attachment('a1')], view: 'solution' })
    const result = await actions.clear()
    expect(result).toBe(true)
    expect(client.clearAttachments).toHaveBeenCalledTimes(1)
    expect(store.getState().attachments).toEqual([])
    expect(store.getState().view).toBe('queue')
  })

  it('reset is blocked while a turn is active', async () => {
    const { store, client, actions } = setup()
    store.getState().dispatch({ type: 'initiate', kind: 'chat' })
    await actions.reset()
    expect(client.clearAttachments).not.toHaveBeenCalled()
    expect(client.createSession).not.toHaveBeenCalled()
  })

  it('reset creates a fresh session when idle', async () => {
    const { store, client, actions } = setup({}, { messages: [{ role: 'user', content: 'x' }] })
    await actions.reset()
    expect(client.createSession).toHaveBeenCalledTimes(1)
    expect(store.getState().sessionId).toBe('new-session')
    expect(store.getState().messages).toEqual([])
    expect(store.getState().notice).toBe('New session ready.')
  })
})

describe('createOverlayActions — discard', () => {
  it('removes the attachment', async () => {
    const { store, client, actions } = setup(
      {},
      { attachments: [attachment('a1'), attachment('a2')] },
    )
    await actions.discard('a1')
    expect(client.discardAttachment).toHaveBeenCalledWith('a1')
    expect(store.getState().attachments.map((a) => a.id)).toEqual(['a2'])
  })

  it('locks out a concurrent discard of the same id', async () => {
    let resolveDiscard: (() => void) | undefined
    const discardAttachment = vi.fn(
      () => new Promise<void>((resolve) => { resolveDiscard = () => resolve() }),
    )
    const { client, actions } = setup(
      { discardAttachment },
      { attachments: [attachment('a1')] },
    )
    const first = actions.discard('a1')
    await actions.discard('a1') // locked out — resolves immediately
    expect(client.discardAttachment).toHaveBeenCalledTimes(1)
    resolveDiscard?.()
    await first
  })
})

describe('createOverlayActions — dismissSolution / stopActiveChat', () => {
  it('dismissSolution dispatches dismiss and switches to queue', () => {
    const { store, actions } = setup()
    store.getState().dispatch({ type: 'initiate', kind: 'solve' })
    store.getState().dispatch({ type: 'started', kind: 'solve', sessionId: 'sess-1', turnId: 'turn-1' })
    actions.dismissSolution()
    expect(store.getState().view).toBe('queue')
    expect(store.getState().turn.dismissed).toBe(true)
  })

  it('stopActiveChat sets the stopped error and dispatches dismiss', () => {
    const { store, actions } = setup()
    store.getState().dispatch({ type: 'initiate', kind: 'chat' })
    store.getState().dispatch({ type: 'started', kind: 'chat', sessionId: 'sess-1', turnId: 'turn-1' })
    actions.stopActiveChat()
    expect(store.getState().streamError).toBe('Response stopped.')
    expect(store.getState().turn.dismissed).toBe(true)
  })
})
