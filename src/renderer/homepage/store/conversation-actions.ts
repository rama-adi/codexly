import type { StoreApi } from 'zustand/vanilla'

import { isActive } from '../../shared/turn/turn-machine'
import type { ConversationStoreState } from './contract'

/**
 * The async command orchestration for the History composer.
 *
 * Like the overlay's actions these are deliberately thin, because the turn
 * machine (hosted by the store) owns every bit of turn-identity reconciliation:
 * an action only has to guard double-submit, update the store optimistically,
 * dispatch a machine input, and feed the settled/failed command result back in.
 *
 * The authoritative turnId is adopted from the `sendMessage` RESULT rather than
 * waiting for the first stream event, which is what makes Stop reachable during
 * the whole thinking phase.
 */

/** The result shape `conversation.send` resolves with. */
export interface CommandTurnResult {
  sessionId: string
  turnId: string
}

/**
 * The SUBSET of the desktop client the actions depend on. `stopTurn` is
 * deliberately absent: stopping is a machine EFFECT interpreted by the store's
 * transport, never called from here.
 */
export interface ConversationActionsClient {
  sendMessage(input: {
    sessionId: string
    message: string
    modelId: string
    attachmentIds: string[]
  }): Promise<CommandTurnResult>
}

export interface HistoryConversationActions {
  /** Sends the trimmed composer value in the currently-selected session. */
  send(modelId: string): Promise<void>
  /** Asks the machine to preempt the active turn; it decides whether to stop. */
  stop(): void
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback

export function createConversationActions(
  store: StoreApi<ConversationStoreState>,
  client: ConversationActionsClient,
): HistoryConversationActions {
  const getState = () => store.getState()

  const send: HistoryConversationActions['send'] = async (modelId) => {
    const message = getState().composerText.trim()
    const sessionId = getState().sessionId
    if (!message || !sessionId || !modelId || isActive(getState().turn)) return

    getState().dispatch({ type: 'initiate', kind: 'chat', sessionId })
    getState().resetTranscript()
    getState().set({
      composerText: '',
      composerError: undefined,
      pendingUser: {
        id: `pending-${Date.now()}`,
        sessionId,
        content: message,
        createdAt: new Date().toISOString(),
      },
    })

    try {
      const result = await client.sendMessage({ sessionId, message, modelId, attachmentIds: [] })
      getState().dispatch({
        type: 'commandSettled',
        sessionId: result.sessionId,
        turnId: result.turnId,
      })
    } catch (error) {
      getState().dispatch({ type: 'commandFailed' })
      // Roll back the optimistic bubble and restore the composer, unless the
      // user has already started typing something new.
      getState().set({
        pendingUser: null,
        composerText: getState().composerText || message,
        composerError: errorMessage(error, 'The message could not be sent.'),
      })
    }
  }

  const stop: HistoryConversationActions['stop'] = () => {
    getState().dispatch({ type: 'dismiss' })
  }

  return { send, stop }
}
