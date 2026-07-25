import { useEffect } from 'react'
import type { StoreApi } from 'zustand/vanilla'

import { DEFAULT_SHORTCUTS } from '../../../shared/schemas/settings'
import { desktopClient } from '../../desktop'
import { createTranscriptSync } from '../../shared/turn/transcript-sync'
import type { OverlayStoreState } from '../store/contract'
import type { Attachment } from '../types'

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Subscribes the overlay store to the main-process product event stream. This
 * is the counterpart to the store's turn dispatch: every event is fed to the
 * turn machine (which decides acceptance / stops / errors), and only accepted
 * events mutate the transcript, activities, or attachment queue.
 *
 * Accepted events are then checked for continuity: the sequence stamped by the
 * main process tells a replayed event (skip) apart from a dropped one (re-sync
 * against the authoritative snapshot instead of appending onto a transcript with
 * a hole in it).
 */
export function useProductEventBridge(store: StoreApi<OverlayStoreState>): void {
  useEffect(() => {
    if (!desktopClient.available) return
    const state = () => store.getState()

    void desktopClient
      .listAttachments()
      .then((loaded) => state().mergeLoadedAttachments(loaded as Attachment[]))
      .catch((error) =>
        state().reportError(errorText(error, 'Could not load the screenshot queue.')),
      )

    const sync = createTranscriptSync({
      fetchSnapshot: (turnId) => desktopClient.transcriptSnapshot(turnId),
      applySnapshot: (snapshot) => {
        // The turn may have been superseded while the snapshot was in flight.
        const turn = state().turn
        if (turn.phase !== 'active' || turn.scope.turnId !== snapshot.turnId) return
        state().replaceTranscript({ answer: snapshot.answer, reasoning: snapshot.reasoning })
        state().replaceToolOutputs(snapshot.toolOutputs)
      },
      onError: (message) => state().reportError(message),
    })

    return desktopClient.onProductEvent((event) => {
      // Turns started from the homepage stream into that window; the overlay
      // must not hijack them.
      if ('origin' in event && event.origin === 'homepage') return

      switch (event.type) {
        case 'conversation.started': {
          const kind = event.consumedAttachmentIds.length ? 'solve' : 'chat'
          event.consumedAttachmentIds.forEach((id) => state().removeAttachment(id))
          const { accepted, freshStart } = state().dispatch({
            type: 'started',
            kind,
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          // A `started` that only served to stop a pre-dismissed turn must not
          // reveal the turn.
          if (state().turn.dismissed) return
          if (freshStart) {
            state().resetTranscript()
            state().clearActivities()
            state().set({ visibleError: undefined })
          }
          state().setSessionId(event.sessionId)
          if (event.consumedAttachmentIds.length) state().set({ view: 'solution' })
          else if (kind === 'chat') state().set({ view: 'chat' })
          return
        }

        case 'overlay.opened': {
          if (!event.fresh && event.sessionId === state().sessionId) return
          state().dispatch({ type: 'reset', stopActive: true })
          state().resetTranscript()
          state().clearActivities()
          state().set({ messages: [] })
          state().setSessionId(event.sessionId ?? undefined)
          if (event.sessionId) {
            const continuedId = event.sessionId
            state().set({ view: 'chat' })
            void desktopClient
              .getSession(continuedId)
              .then((session) => {
                if (!session || state().sessionId !== continuedId) return
                state().set({
                  messages: session.messages
                    .filter((message) => message.role === 'user' || message.role === 'assistant')
                    .map((message) => ({
                      role: message.role as 'user' | 'assistant',
                      content: message.content,
                    })),
                })
              })
              .catch((error) =>
                state().reportError(errorText(error, 'Could not load the continued session.')),
              )
          } else {
            state().set({ view: 'queue' })
          }
          return
        }

        case 'attachment.captured': {
          state().addAttachment(event.attachment as Attachment)
          state().set({ notice: 'Screenshot captured.' })
          return
        }

        case 'attachments.cleared': {
          state().clearAttachments()
          state().set({ notice: 'Screenshot queue cleared.' })
          return
        }

        case 'transcript.gap': {
          // The transport told us it discarded part of this turn's stream.
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
          if (!state().sessionId) state().setSessionId(event.sessionId)
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
          if (!state().sessionId) state().setSessionId(event.sessionId)
          state().set({ streamError: undefined })
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
            const answer = state().answer
            if (!answer.trim()) {
              state().set({
                streamError: 'Codex completed without returning an answer. Please try again.',
              })
            }
            if (answer) state().appendMessage({ role: 'assistant', content: answer })
            state().set({ notice: 'Response complete.' })
          })
          return
        }

        case 'transcript.failed': {
          sync.settleTerminal(event, () => {
            const kindBefore = state().turn.kind
            const { accepted } = state().dispatch({
              type: 'terminal',
              sessionId: event.sessionId,
              turnId: event.turnId,
              outcome: 'failed',
            })
            if (!accepted) return
            state().flushTranscript()
            state().set({ streamError: event.message })
            const answer = state().answer
            if (kindBefore === 'chat' && answer) {
              state().appendMessage({ role: 'assistant', content: answer })
              state().set({ answer: '' })
            }
            state().set({ notice: event.message })
          })
          return
        }

        case 'tool.status': {
          const { accepted } = state().dispatch({
            type: 'streamEvent',
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          // Not gated: a status event carries the activity's identity, which no
          // snapshot can restore, so skipping it would lose the activity row for
          // good. Continuity is still tracked, so a hole here re-syncs the text.
          sync.noteUnrecoverable(event)
          state().applyToolStatus({
            activityId: event.activityId,
            name: event.name,
            state: event.state,
            detail: event.detail,
            sequence: event.sequence,
          })
          return
        }

        case 'tool.output': {
          const { accepted } = state().dispatch({
            type: 'streamEvent',
            sessionId: event.sessionId,
            turnId: event.turnId,
          })
          if (!accepted) return
          if (!sync.gate(event)) return
          state().applyToolOutput({ activityId: event.activityId, text: event.text })
          return
        }

        case 'settings.changed': {
          state().set({
            answerHeight: event.settings.appearance.answerHeight,
            shortcuts: event.settings.shortcuts ?? DEFAULT_SHORTCUTS,
          })
          return
        }
      }
    })
  }, [store])
}
