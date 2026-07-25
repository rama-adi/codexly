import { createStore, type StoreApi } from 'zustand/vanilla'

import { DEFAULT_SHORTCUTS } from '../../../shared/schemas/settings'
import {
  IDLE_TURN,
  reduceTurn,
  type TurnInput,
  type TurnResult,
} from '../../shared/turn/turn-machine'
import type { Attachment, ModelChoice, ToolActivity } from '../types'
import {
  MAX_ATTACHMENTS,
  type CreateOverlayStoreOptions,
  type OverlayState,
  type OverlayStoreState,
  type ToolOutputEvent,
  type ToolStatusEvent,
} from './contract'

const FALLBACK_MODELS: ModelChoice[] = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4' },
]
const DEFAULT_ANSWER_HEIGHT = 340
const MAX_TOOL_OUTPUT_LENGTH = 64 * 1024

/** Append `chunk` to a tool's captured output, bounded to MAX_TOOL_OUTPUT_LENGTH. */
function appendToolOutput(current: string | undefined, chunk: string): string {
  const existing = current ?? ''
  if (existing.length >= MAX_TOOL_OUTPUT_LENGTH) return existing
  return existing + chunk.slice(0, MAX_TOOL_OUTPUT_LENGTH - existing.length)
}

function defaultState(): OverlayState {
  return {
    turn: IDLE_TURN,
    view: 'queue',
    answer: '',
    reasoning: '',
    streamError: undefined,
    activities: [],
    attachments: [],
    messages: [],
    chatInput: '',
    sessionId: undefined,
    models: FALLBACK_MODELS,
    modelId: FALLBACK_MODELS[0].id,
    answerHeight: DEFAULT_ANSWER_HEIGHT,
    shortcuts: DEFAULT_SHORTCUTS,
    notice: 'Screenshot queue ready.',
    visibleError: undefined,
  }
}

/**
 * Create a fresh overlay store. The transcript/activity/attachment
 * reconciliation buffers live in this closure (non-reactive), NOT in
 * {@link OverlayState}, so the rAF batching can accumulate without triggering
 * renders on every chunk.
 */
export function createOverlayStore(
  options: CreateOverlayStoreOptions,
): StoreApi<OverlayStoreState> {
  const { transport } = options

  // --- non-reactive reconciliation state (module-private, closure) ----------
  let answerBuffer = ''
  let reasoningBuffer = ''
  let streamFrame: number | undefined
  // Tool output that arrived before its status event — keyed by activityId.
  const pendingToolOutputs = new Map<string, string>()
  // Attachment ids the user removed; a late bulk load must not re-add them.
  const removedAttachmentIds = new Set<string>()
  // Set when the queue is cleared so an in-flight bulk load result is ignored.
  let attachmentLoadInvalidated = false

  const hasRaf =
    typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'

  const initial: OverlayState = { ...defaultState(), ...options.initial }

  const store = createStore<OverlayStoreState>((setState, getState) => {
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

    // When a stop fails and the machine revives the still-running turn, restore
    // its panel and surface the real transport error (which only the store
    // knows). The machine deliberately reports nothing for this case.
    const recoverFromFailedStop = (turn: TurnResult['state'], message: string) => {
      if (turn.phase !== 'active' || turn.dismissed) return
      setState({ view: turn.kind === 'chat' ? 'chat' : 'solution' })
      getState().reportError(message)
    }

    const dispatch = (input: TurnInput): TurnResult => {
      const result = reduceTurn(getState().turn, input)
      setState({ turn: result.state })
      for (const effect of result.effects) {
        if (effect.type === 'stopTurn') {
          // The machine only emits stopTurn once per turn (it latches
          // `stopInFlight`), so no extra re-entrancy guard is needed here.
          transport
            .stopTurn(effect.turnId)
            .then((ok) => {
              const settled = dispatch({ type: 'stopSettled', ok })
              if (!ok) {
                recoverFromFailedStop(
                  settled.state,
                  'The response could not be stopped. It is still running.',
                )
              }
            })
            .catch((error) => {
              const settled = dispatch({ type: 'stopSettled', ok: false })
              recoverFromFailedStop(
                settled.state,
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

      // --- transcript: buffered, rAF-batched when available -----------------
      appendTranscript: (chunk) => {
        if (chunk.answer) answerBuffer += chunk.answer
        if (chunk.reasoning) reasoningBuffer += chunk.reasoning
        scheduleRender()
      },

      flushTranscript: () => {
        cancelFrame()
        renderTranscript()
      },

      resetTranscript: () => {
        cancelFrame()
        answerBuffer = ''
        reasoningBuffer = ''
        pendingToolOutputs.clear()
        setState({ answer: '', reasoning: '', streamError: undefined })
      },

      replaceTranscript: ({ answer, reasoning }) => {
        cancelFrame()
        answerBuffer = answer
        reasoningBuffer = reasoning
        renderTranscript()
      },

      // --- tool activity reconciliation -------------------------------------
      applyToolStatus: (event: ToolStatusEvent) => {
        const key = event.activityId ?? event.name
        const current = getState().activities
        const index = current.findIndex((activity) => activity.key === key)
        const existing = index >= 0 ? current[index] : undefined
        // A status the transport reordered must not roll an existing row back to
        // an older state. The row's identity is already established, so dropping
        // the stale state is safe — unlike skipping a status for an unseen
        // activity, which would lose the row entirely.
        const stale =
          existing !== undefined &&
          existing.sequence !== undefined &&
          event.sequence !== undefined &&
          event.sequence <= existing.sequence
        const next: ToolActivity = {
          key,
          activityId: event.activityId ?? existing?.activityId,
          name: stale ? existing.name : event.name,
          state: stale ? existing.state : event.state,
          detail: stale ? existing.detail : event.detail,
          sequence: stale ? existing.sequence : event.sequence,
          output:
            (event.activityId && pendingToolOutputs.get(event.activityId)) ??
            existing?.output,
        }
        if (event.activityId) pendingToolOutputs.delete(event.activityId)
        if (index >= 0) {
          const copy = current.slice()
          copy[index] = next
          setState({ activities: copy })
        } else {
          setState({ activities: [...current, next] })
        }
      },

      applyToolOutput: (event: ToolOutputEvent) => {
        const current = getState().activities
        if (!current.some((activity) => activity.activityId === event.activityId)) {
          // The status event has not arrived yet — buffer the output so
          // applyToolStatus can attach it once the activity appears.
          pendingToolOutputs.set(
            event.activityId,
            appendToolOutput(pendingToolOutputs.get(event.activityId), event.text),
          )
          return
        }
        setState({
          activities: current.map((activity) =>
            activity.activityId === event.activityId
              ? { ...activity, output: appendToolOutput(activity.output, event.text) }
              : activity,
          ),
        })
      },

      replaceToolOutputs: (outputs) => {
        const byActivity = new Map(outputs.map((output) => [output.activityId, output.text]))
        setState({
          activities: getState().activities.map((activity) =>
            activity.activityId !== undefined && byActivity.has(activity.activityId)
              ? { ...activity, output: byActivity.get(activity.activityId) }
              : activity,
          ),
        })
        // Output whose status event has not arrived yet stays buffered, so
        // applyToolStatus attaches the authoritative text when it does.
        const known = new Set(
          getState()
            .activities.map((activity) => activity.activityId)
            .filter((id): id is string => id !== undefined),
        )
        for (const [activityId, text] of byActivity) {
          if (!known.has(activityId)) pendingToolOutputs.set(activityId, text)
        }
      },

      clearActivities: () => setState({ activities: [] }),

      // --- attachment queue reconciliation ----------------------------------
      addAttachment: (attachment: Attachment) => {
        // A re-captured id is no longer "removed".
        removedAttachmentIds.delete(attachment.id)
        const current = getState().attachments
        if (current.some((item) => item.id === attachment.id)) return
        setState({ attachments: [...current, attachment].slice(0, MAX_ATTACHMENTS) })
      },

      removeAttachment: (id: string) => {
        removedAttachmentIds.add(id)
        setState({ attachments: getState().attachments.filter((item) => item.id !== id) })
      },

      mergeLoadedAttachments: (loaded: Attachment[]) => {
        if (attachmentLoadInvalidated) return
        const current = getState().attachments
        // `seen` grows as the batch is walked, so a batch that repeats an id
        // cannot land the same screenshot in the queue twice.
        const seen = new Set(current.map((item) => item.id))
        const additions: Attachment[] = []
        for (const item of loaded) {
          if (removedAttachmentIds.has(item.id) || seen.has(item.id)) continue
          seen.add(item.id)
          additions.push(item)
        }
        setState({ attachments: [...current, ...additions].slice(0, MAX_ATTACHMENTS) })
      },

      clearAttachments: () => {
        attachmentLoadInvalidated = true
        setState({ attachments: [] })
      },

      // --- chat transcript --------------------------------------------------
      appendMessage: (message) =>
        setState({ messages: [...getState().messages, message] }),

      setSessionId: (id) => setState({ sessionId: id }),

      reportError: (message) => {
        // Mirror the failure to the renderer console so overlay problems are
        // diagnosable alongside the main-process logs.
        console.error(`[overlay] ${message}`)
        setState({ notice: message, visibleError: message })
      },
    }
  })

  // Dev-only: lets the browser harness' inspector report real store state. The
  // guard is compiled away in production, and the registry only exists when the
  // harness created it.
  if (import.meta.env.DEV) globalThis.__codexlyDevStores?.set('overlay', store)

  return store
}
