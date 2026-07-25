import type { TurnInput, TurnResult, TurnState } from '../../shared/turn/turn-machine'

/**
 * The frozen contract for the History page's conversation store.
 *
 * The store owns the TURN lifecycle (delegated to the shared turn machine) plus
 * everything the turn mutates: the streaming transcript, the optimistic user
 * bubble, and the composer. Purely presentational concerns that no turn event
 * touches — the loaded session detail, attachment previews, the delete dialog —
 * stay as plain React state in the page.
 */

/** The locally-echoed user message shown until the server transcript catches up. */
export interface PendingUserMessage {
  id: string
  sessionId: string
  content: string
  createdAt: string
}

/** Which half of the stream is currently arriving. */
export type StreamPhase = 'reasoning' | 'answering'

/** The IPC surface the store needs in order to interpret machine effects. */
export interface ConversationTransport {
  stopTurn(turnId: string): Promise<boolean>
}

export interface ConversationState {
  /** The turn lifecycle machine state (see shared/turn/turn-machine.ts). */
  turn: TurnState
  /** The session this store is tracking; the single source of truth for selection. */
  sessionId: string | null
  /** Rendered transcript (updated via the batched appendTranscript path). */
  answer: string
  reasoning: string
  streamPhase: StreamPhase
  /** Whether the Thinking disclosure is open (auto-toggled on phase changes). */
  thinkingExpanded: boolean
  pendingUser: PendingUserMessage | null
  /** The controlled composer value (in the store so `send` can restore it). */
  composerText: string
  composerError?: string
}

export interface ConversationActions {
  /**
   * Runs the turn machine for `input`, applies the resulting state, and
   * interprets every returned effect:
   *   - `stopTurn`    → transport.stopTurn(id), fed back as a `stopSettled` input,
   *   - `reportError` → reportError(message).
   * Whenever a turn ends (active → idle for any reason other than a session
   * switch) the optimistic bubble is dropped and `onTurnEnded` is notified so the
   * page can refetch the now-persisted transcript.
   */
  dispatch(input: TurnInput): TurnResult

  /** Shallow-merge for trivial scalar fields (composerText, thinkingExpanded, …). */
  set(partial: Partial<ConversationState>): void

  // --- transcript: buffered, rAF-batched when available, sync otherwise ------
  appendTranscript(chunk: { answer?: string; reasoning?: string }): void
  /** Force any buffered transcript into the rendered state immediately. */
  flushTranscript(): void
  /** Clear transcript buffers + rendered answer/reasoning. */
  resetTranscript(): void
  /**
   * Overwrite the transcript with an authoritative main-side copy, used when the
   * event stream is found to have a gap: the locally accumulated text is missing
   * a middle and cannot be repaired by appending.
   */
  replaceTranscript(transcript: { answer: string; reasoning: string }): void

  /**
   * Point the store at a different session. Any turn in flight is ABANDONED, not
   * stopped: it keeps running in the main process so its answer still persists,
   * but its late events can never leak into the newly-selected conversation.
   */
  selectSession(sessionId: string | null): void

  /** Surface a failure in the composer banner. */
  reportError(message: string): void
}

export type ConversationStoreState = ConversationState & ConversationActions

export interface CreateConversationStoreOptions {
  transport: ConversationTransport
  /** Called with the session id whose turn just ended, so the page can refetch. */
  onTurnEnded?: (sessionId: string) => void
  /** Seed overrides (used by tests). */
  initial?: Partial<ConversationState>
}
