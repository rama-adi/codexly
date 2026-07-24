import type { Shortcuts } from '../../../shared/schemas/settings'
import type { TurnInput, TurnState } from '../machine/turn-machine'
import type { Attachment, ChatMessage, ModelChoice, ToolActivity, View } from '../types'

/**
 * The frozen contract for the overlay's zustand store. The store is the single
 * state hub: it hosts the turn machine, owns the transcript/activity/attachment
 * reconciliation, and interprets the machine's effects. Actions, hooks, and the
 * view all depend ONLY on these types, which is what lets those modules be built
 * and tested independently of the store implementation.
 */

/** Hard cap on the pending screenshot queue. */
export const MAX_ATTACHMENTS = 5

/** The IPC surface the store itself needs, to interpret machine effects. */
export interface OverlayTransport {
  stopTurn(turnId: string): Promise<boolean>
}

export interface OverlayState {
  /** The turn lifecycle machine state (see machine/turn-machine.ts). */
  turn: TurnState
  view: View
  /** Rendered transcript (updated via the batched appendTranscript path). */
  answer: string
  reasoning: string
  streamError?: string
  activities: ToolActivity[]
  attachments: Attachment[]
  messages: ChatMessage[]
  /** The controlled chat composer value (in the store so actions can restore it). */
  chatInput: string
  sessionId?: string
  models: ModelChoice[]
  modelId: string
  answerHeight: number
  shortcuts: Shortcuts
  /** Screen-reader status line. */
  notice: string
  /** Visible error banner. */
  visibleError?: string
}

export interface ToolStatusEvent {
  activityId?: string
  name: string
  state: 'running' | 'complete' | 'error'
  detail?: string
}

export interface ToolOutputEvent {
  activityId: string
  text: string
}

export interface OverlayActions {
  /**
   * Runs the turn machine for `input`, applies the resulting state, and
   * interprets every returned effect:
   *   - `stopTurn`   → transport.stopTurn(id), feeding the result back as a
   *                    `stopSettled` input (ok on success/false on rejection).
   *   - `reportError`→ reportError(message).
   * The `accepted`/`freshStart` verdicts are used by the event bridge (which
   * calls dispatch) to decide whether to apply transcript/activity mutations.
   * Returns the full TurnResult so callers can act on `accepted`/`freshStart`.
   */
  dispatch(input: TurnInput): import('../machine/turn-machine').TurnResult

  /** Shallow-merge for trivial scalar/array fields (view, modelId, models, …). */
  set(partial: Partial<OverlayState>): void

  // --- transcript: buffered, rAF-batched when available, sync otherwise ------
  appendTranscript(chunk: { answer?: string; reasoning?: string }): void
  /** Force any buffered transcript into the rendered state immediately. */
  flushTranscript(): void
  /** Clear transcript buffers + rendered answer/reasoning + streamError. */
  resetTranscript(): void

  // --- tool activity reconciliation -----------------------------------------
  applyToolStatus(event: ToolStatusEvent): void
  applyToolOutput(event: ToolOutputEvent): void
  clearActivities(): void

  // --- attachment queue reconciliation --------------------------------------
  /** Add one captured attachment (deduped, capped at MAX_ATTACHMENTS). */
  addAttachment(attachment: Attachment): void
  /** Remove one attachment and remember it so a late load cannot re-add it. */
  removeAttachment(id: string): void
  /** Merge a bulk load, skipping removed/duplicate ids and honoring the cap. */
  mergeLoadedAttachments(loaded: Attachment[]): void
  /** Clear the queue and invalidate any in-flight bulk load. */
  clearAttachments(): void

  // --- chat transcript -------------------------------------------------------
  appendMessage(message: ChatMessage): void

  setSessionId(id: string | undefined): void
  /** Surface an error to both the notice line and the visible banner. */
  reportError(message: string): void
}

export type OverlayStoreState = OverlayState & OverlayActions

export interface CreateOverlayStoreOptions {
  transport: OverlayTransport
  /** Seed overrides (used by tests and by the initial settings/model load). */
  initial?: Partial<OverlayState>
}
