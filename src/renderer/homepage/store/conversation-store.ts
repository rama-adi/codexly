import { createStore, type StoreApi } from 'zustand/vanilla'

import {
  IDLE_TURN,
  reduceTurn,
  type TurnInput,
  type TurnResult,
} from '../../shared/turn/turn-machine'
import type {
  ConversationState,
  ConversationStoreState,
  CreateConversationStoreOptions,
} from './contract'

function defaultState(): ConversationState {
  return {
    turn: IDLE_TURN,
    sessionId: null,
    answer: '',
    reasoning: '',
    streamPhase: 'reasoning',
    thinkingExpanded: true,
    pendingUser: null,
    composerText: '',
    composerError: undefined,
  }
}

/**
 * Create a fresh conversation store for one History page mount. The transcript
 * reconciliation buffers live in this closure (non-reactive), NOT in
 * {@link ConversationState}, so the rAF batching can accumulate stream chunks
 * without triggering a render per token.
 */
export function createConversationStore(
  options: CreateConversationStoreOptions,
): StoreApi<ConversationStoreState> {
  const { transport, onTurnEnded } = options

  let answerBuffer = ''
  let reasoningBuffer = ''
  let streamFrame: number | undefined

  const hasRaf =
    typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'

  const initial: ConversationState = { ...defaultState(), ...options.initial }

  return createStore<ConversationStoreState>((setState, getState) => {
    const renderTranscript = () => setState({ answer: answerBuffer, reasoning: reasoningBuffer })

    const cancelFrame = () => {
      if (streamFrame !== undefined) {
        if (hasRaf) cancelAnimationFrame(streamFrame)
        streamFrame = undefined
      }
    }

    const scheduleRender = () => {
      if (!hasRaf) {
        renderTranscript()
        return
      }
      if (streamFrame !== undefined) return
      streamFrame = requestAnimationFrame(() => {
        streamFrame = undefined
        renderTranscript()
      })
    }

    const resetTranscript = () => {
      cancelFrame()
      answerBuffer = ''
      reasoningBuffer = ''
      setState({ answer: '', reasoning: '', streamPhase: 'reasoning', thinkingExpanded: true })
    }

    const dispatch = (input: TurnInput): TurnResult => {
      const before = getState().turn
      const result = reduceTurn(before, input)
      setState({ turn: result.state })

      // The turn is over: the message the optimistic bubble stood in for is now
      // owned by the persisted transcript, so drop it and ask for a refetch.
      // Excluded are the two endings that persisted nothing — a session switch
      // (`selectSession` has already cleared up, and the abandoned turn belongs
      // to a session that is no longer on screen) and a rejected command (the
      // action rolls its own optimistic state back).
      if (
        input.type !== 'reset' &&
        input.type !== 'commandFailed' &&
        before.phase === 'active' &&
        result.state.phase === 'idle'
      ) {
        const endedSession = before.scope.sessionId ?? getState().sessionId
        if (getState().pendingUser) setState({ pendingUser: null })
        if (endedSession) onTurnEnded?.(endedSession)
      }

      for (const effect of result.effects) {
        if (effect.type === 'stopTurn') {
          // The machine latches `stopInFlight`, so it only emits stopTurn once
          // per turn and no extra re-entrancy guard is needed here.
          transport
            .stopTurn(effect.turnId)
            .then((ok) => {
              dispatch({ type: 'stopSettled', ok })
              if (!ok) {
                getState().reportError('The response could not be stopped. It is still running.')
              }
            })
            .catch((error) => {
              dispatch({ type: 'stopSettled', ok: false })
              getState().reportError(
                error instanceof Error && error.message
                  ? error.message
                  : 'Could not stop the active response. It is still running.',
              )
            })
        } else if (effect.type === 'reportError') {
          getState().reportError(effect.message)
        }
      }
      return result
    }

    return {
      ...initial,

      dispatch,

      set: (partial) => setState(partial),

      appendTranscript: (chunk) => {
        if (chunk.answer) answerBuffer += chunk.answer
        if (chunk.reasoning) reasoningBuffer += chunk.reasoning
        scheduleRender()
      },

      flushTranscript: () => {
        cancelFrame()
        renderTranscript()
      },

      resetTranscript,

      replaceTranscript: ({ answer, reasoning }) => {
        cancelFrame()
        answerBuffer = answer
        reasoningBuffer = reasoning
        renderTranscript()
      },

      selectSession: (sessionId) => {
        if (getState().sessionId === sessionId) return
        dispatch({ type: 'reset', stopActive: false })
        resetTranscript()
        setState({ sessionId, pendingUser: null, composerError: undefined })
      },

      reportError: (message) => {
        console.error(`[homepage] ${message}`)
        setState({ composerError: message })
      },
    }
  })
}
