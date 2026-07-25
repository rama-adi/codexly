import { useEffect } from 'react'
import type { StoreApi } from 'zustand/vanilla'

import { desktopClient } from '../../desktop'
import { createTranscriptSync } from '../../shared/turn/transcript-sync'
import type { ConversationStoreState } from '../store/contract'

/**
 * Subscribes the History conversation store to the main-process product event
 * stream. Every transcript event is fed to the turn machine, which decides
 * acceptance; only accepted events mutate the transcript.
 *
 * Two filters apply, in this order:
 *   1. ORIGIN — turns started from the overlay stream into that window, so the
 *      homepage must ignore them entirely. Without this an overlay conversation
 *      in the selected session renders a phantom streaming bubble here and its
 *      terminal event releases this composer.
 *   2. SCOPE — the machine matches sessionId/turnId against the turn this store
 *      owns, so a homepage turn in another session cannot leak in either.
 *   3. CONTINUITY — the per-turn sequence stamped by the main process separates a
 *      replayed event (skip) from a dropped one (re-sync the transcript from the
 *      authoritative snapshot rather than appending onto a hole).
 */
export function useConversationEventBridge(store: StoreApi<ConversationStoreState>): void {
  useEffect(() => {
    if (!desktopClient.available) return
    const state = () => store.getState()

    const sync = createTranscriptSync({
      fetchSnapshot: (turnId) => desktopClient.transcriptSnapshot(turnId),
      applySnapshot: (snapshot) => {
        // The turn may have been superseded while the snapshot was in flight.
        const turn = state().turn
        if (turn.phase !== 'active' || turn.scope.turnId !== snapshot.turnId) return
        state().replaceTranscript({ answer: snapshot.answer, reasoning: snapshot.reasoning })
      },
      onError: (message) => state().reportError(message),
    })

    return desktopClient.onProductEvent((event) => {
      if ('origin' in event && event.origin !== 'homepage') return

      switch (event.type) {
        case 'tool.status':
        case 'tool.output': {
          // The History view has no activity feed, but these events still CONSUME
          // sequences. Ignoring them outright would make every tool call look like
          // a hole and fetch a needless snapshot, so their continuity is tracked
          // even though nothing is rendered.
          const { accepted } = state().dispatch({
            type: 'streamEvent',
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          sync.gate(event)
          return
        }

        case 'transcript.gap': {
          const { accepted } = state().dispatch({
            type: 'streamEvent',
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          sync.noteGap(event.turnId)
          return
        }

        case 'transcript.reasoning': {
          const { accepted } = state().dispatch({
            type: 'streamEvent',
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          if (!sync.gate(event)) return
          // Only auto-open the disclosure when the phase actually changes, so a
          // manual collapse is not fought by every following chunk.
          if (state().streamPhase !== 'reasoning') {
            state().set({ streamPhase: 'reasoning', thinkingExpanded: true })
          }
          state().appendTranscript({ reasoning: event.text })
          return
        }

        case 'transcript.delta': {
          const { accepted } = state().dispatch({
            type: 'streamEvent',
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          if (!sync.gate(event)) return
          if (state().streamPhase !== 'answering') {
            state().set({ streamPhase: 'answering', thinkingExpanded: false })
          }
          state().appendTranscript({ answer: event.text })
          return
        }

        case 'transcript.complete': {
          sync.settleTerminal(event, () => {
            const { accepted } = state().dispatch({
              type: 'terminal',
              sessionId: event.sessionId,
              turnId: event.turnId,
              outcome: 'complete',
            })
            if (!accepted) return
            state().flushTranscript()
          })
          return
        }

        case 'transcript.failed': {
          sync.settleTerminal(event, () => {
            const { accepted } = state().dispatch({
              type: 'terminal',
              sessionId: event.sessionId,
              turnId: event.turnId,
              outcome: 'failed',
            })
            if (!accepted) return
            state().flushTranscript()
            state().set({ composerError: event.message })
          })
          return
        }
      }
    })
  }, [store])
}
