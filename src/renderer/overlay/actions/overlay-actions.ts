import type { StoreApi } from 'zustand/vanilla'

import { isActive } from '../../shared/turn/turn-machine'
import type { OverlayStoreState } from '../store/contract'

/**
 * The async command orchestration for the overlay — the user-triggered action
 * handlers extracted from Overlay.tsx.
 *
 * These are deliberately thin: the turn machine (hosted by the store) now owns
 * all turn-identity reconciliation, so an action only has to
 *   1. guard against double-invocation / an already-active turn,
 *   2. optimistically update the store,
 *   3. dispatch a machine input, and
 *   4. call the injected client, feeding the settled/failed result back in.
 * Conflict / dismiss / terminal handling that the old `settleCommand`,
 * `finishRequest`, and `stopRequest` helpers performed by hand is now entirely
 * inside `reduceTurn` + the store's effect interpreter.
 */

/** The result shape the IPC command (solve/send) resolves with. */
export interface CommandTurnResult {
  sessionId: string
  turnId: string
}

/** Input accepted by {@link OverlayActionsClient.sendMessage}. */
export interface SendMessageInput {
  sessionId?: string
  message: string
  modelId: string
  attachmentIds: string[]
}

/**
 * The SUBSET of the desktop client the actions depend on. Note `stopTurn` is
 * deliberately absent: stopping a turn is a machine EFFECT interpreted by the
 * store's transport, never called from here.
 */
export interface OverlayActionsClient {
  capture(): Promise<unknown>
  captureSelection(): Promise<unknown>
  solvePending(modelId: string): Promise<CommandTurnResult>
  sendMessage(input: SendMessageInput): Promise<CommandTurnResult>
  clearAttachments(): Promise<unknown>
  discardAttachment(id: string): Promise<unknown>
  createSession(): Promise<{ id: string }>
  openHome(): Promise<unknown>
  toggleOverlay(preserveSession?: boolean): Promise<unknown>
}

export interface OverlayActions {
  capture(): Promise<void>
  captureSelection(): Promise<void>
  solve(): Promise<void>
  /** `message` is the already-trimmed composer value (the view owns the event). */
  sendChat(message: string): Promise<void>
  clear(): Promise<boolean>
  reset(): Promise<void>
  discard(id: string): Promise<void>
  dismissSolution(): void
  stopActiveChat(): void
  openSettings(): Promise<void>
  hideOverlay(): Promise<void>
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback

export function createOverlayActions(
  store: StoreApi<OverlayStoreState>,
  client: OverlayActionsClient,
): OverlayActions {
  const getState = () => store.getState()

  // Double-invocation guard, private to this closure. Mirrors the old
  // `actionLocksRef` set in Overlay.tsx: 'capture' | 'selection' | 'clear' |
  // 'reset' | `discard:<id>` | 'settings' | 'hide'.
  const locks = new Set<string>()

  const withLock = async (key: string, run: () => Promise<void>): Promise<void> => {
    if (locks.has(key)) return
    locks.add(key)
    try {
      await run()
    } finally {
      locks.delete(key)
    }
  }

  const capture: OverlayActions['capture'] = () =>
    withLock('capture', async () => {
      getState().set({ visibleError: undefined })
      try {
        await client.capture()
      } catch (error) {
        getState().reportError(errorMessage(error, 'Capture failed.'))
      }
    })

  const captureSelection: OverlayActions['captureSelection'] = () =>
    withLock('selection', async () => {
      getState().set({ visibleError: undefined })
      try {
        await client.captureSelection()
      } catch (error) {
        getState().reportError(errorMessage(error, 'Selection capture failed.'))
      }
    })

  const solve: OverlayActions['solve'] = async () => {
    const state = getState()
    if (!state.attachments.length || isActive(state.turn)) return
    // The screenshots present when the solve begins are the ones being consumed.
    const consumedIds = state.attachments.map((attachment) => attachment.id)
    store.getState().set({ view: 'solution' })
    store.getState().dispatch({ type: 'initiate', kind: 'solve' })
    store.getState().resetTranscript()
    store.getState().clearActivities()
    store.getState().set({ visibleError: undefined })
    try {
      const result = await client.solvePending(getState().modelId)
      // Optimistically drop the consumed screenshots from the queue (the event
      // bridge also removes them on `conversation.started`; removal is
      // idempotent and remembered so a late load cannot re-add them).
      consumedIds.forEach((id) => store.getState().removeAttachment(id))
      store.getState().dispatch({
        type: 'commandSettled',
        sessionId: result.sessionId,
        turnId: result.turnId,
      })
    } catch (error) {
      const dismissed = getState().turn.dismissed
      store.getState().dispatch({ type: 'commandFailed' })
      if (!dismissed) {
        getState().reportError(errorMessage(error, 'Unable to process screenshots.'))
        store.getState().set({ view: 'queue' })
      }
    }
  }

  const sendChat: OverlayActions['sendChat'] = async (message) => {
    if (!message || isActive(getState().turn)) return
    store.getState().appendMessage({ role: 'user', content: message })
    store.getState().set({ chatInput: '' })
    store.getState().dispatch({ type: 'initiate', kind: 'chat' })
    store.getState().resetTranscript()
    store.getState().clearActivities()
    store.getState().set({ visibleError: undefined })
    try {
      const sessionId = getState().sessionId
      const result = await client.sendMessage({
        ...(sessionId ? { sessionId } : {}),
        message,
        modelId: getState().modelId,
        attachmentIds: getState().attachments.map((attachment) => attachment.id),
      })
      store.getState().dispatch({
        type: 'commandSettled',
        sessionId: result.sessionId,
        turnId: result.turnId,
      })
    } catch (error) {
      store.getState().dispatch({ type: 'commandFailed' })
      // Roll back the optimistic user message if it is still the last one.
      const messages = getState().messages
      const last = messages[messages.length - 1]
      if (last?.role === 'user' && last.content === message) {
        store.getState().set({ messages: messages.slice(0, -1) })
      }
      // Restore the composer only if the user has not started typing again.
      store.getState().set({ chatInput: getState().chatInput || message })
      store.getState().set({
        streamError: `Message was not sent: ${errorMessage(error, 'Unable to send message.')}`,
      })
      getState().reportError(errorMessage(error, 'Unable to send message.'))
    }
  }

  const clear: OverlayActions['clear'] = async () => {
    if (locks.has('clear') || isActive(getState().turn)) return false
    locks.add('clear')
    getState().set({ visibleError: undefined })
    try {
      await client.clearAttachments()
      store.getState().clearAttachments()
      store.getState().resetTranscript()
      store.getState().clearActivities()
      store.getState().set({ view: 'queue' })
      return true
    } catch (error) {
      getState().reportError(errorMessage(error, 'Could not clear the screenshot queue.'))
      return false
    } finally {
      locks.delete('clear')
    }
  }

  const reset: OverlayActions['reset'] = () =>
    withLock('reset', async () => {
      if (isActive(getState().turn)) return
      getState().set({ visibleError: undefined })
      try {
        await client.clearAttachments()
        store.getState().clearAttachments()
        const session = await client.createSession()
        store.getState().setSessionId(session.id)
        store.getState().resetTranscript()
        store.getState().clearActivities()
        // A session reset is not a turn, so no machine input is dispatched.
        store.getState().set({ messages: [], view: 'queue' })
        store.getState().set({ notice: 'New session ready.' })
      } catch (error) {
        getState().reportError(errorMessage(error, 'Could not reset the session.'))
      }
    })

  const discard: OverlayActions['discard'] = (id) =>
    withLock(`discard:${id}`, async () => {
      getState().set({ visibleError: undefined })
      try {
        await client.discardAttachment(id)
        store.getState().removeAttachment(id)
      } catch (error) {
        getState().reportError(
          errorMessage(error, 'Could not remove the screenshot. It is still queued.'),
        )
      }
    })

  const dismissSolution: OverlayActions['dismissSolution'] = () => {
    store.getState().set({ view: 'queue' })
    // The machine decides whether a stop is needed; the store interprets it.
    store.getState().dispatch({ type: 'dismiss' })
  }

  const stopActiveChat: OverlayActions['stopActiveChat'] = () => {
    store.getState().set({ streamError: 'Response stopped.' })
    store.getState().dispatch({ type: 'dismiss' })
  }

  const openSettings: OverlayActions['openSettings'] = () =>
    withLock('settings', async () => {
      getState().set({ visibleError: undefined })
      try {
        // Opening the homepage dismisses the overlay on its own (the two are
        // mutually exclusive surfaces), so this is all that's needed.
        await client.openHome()
      } catch (error) {
        getState().reportError(errorMessage(error, 'Could not open settings.'))
      }
    })

  const hideOverlay: OverlayActions['hideOverlay'] = () =>
    withLock('hide', async () => {
      getState().set({ visibleError: undefined })
      try {
        await client.toggleOverlay()
      } catch (error) {
        getState().reportError(errorMessage(error, 'Could not hide the overlay.'))
      }
    })

  return {
    capture,
    captureSelection,
    solve,
    sendChat,
    clear,
    reset,
    discard,
    dismissSolution,
    stopActiveChat,
    openSettings,
    hideOverlay,
  }
}
