import type { TranscriptSnapshot, TurnOrigin } from '../../src/shared/ipc/product'
import type { TurnEventEnvelope } from '../conversation/turn-controller'
import { createScope, type Scope } from '../effects/scope'
import { logger, serializeErrorForLog } from '../shared/logger'

const log = logger.child('turns')

export type TurnRecordState = 'initiating' | 'announced' | 'streaming' | 'terminal'

/** Bounds for the retained tool output, matching the snapshot contract limits. */
const MAX_SNAPSHOT_TOOL_ACTIVITIES = 200
const MAX_SNAPSHOT_TOOL_OUTPUT_CHARS = 16_000

export type TurnContext = Readonly<{
  origin: TurnOrigin
  persistConversation: boolean
}>

export interface TurnAbortHandle {
  abort(reason?: string): Promise<boolean>
}

/** The registry state a decision function is allowed to look at. */
export interface TurnSnapshot {
  turnId: string
  conversationId: string
  origin: TurnOrigin
  state: TurnRecordState
  completionSettled: boolean
  abortRequested: boolean
  hasAbortHandle: boolean
  /** The announcement is replaying this turn's deferred queue right now. */
  draining: boolean
}

/** What to do with an incoming turn event, given the registry state. */
export type TurnEventDisposition = 'defer' | 'deliver' | 'drop'

// ---------------------------------------------------------------------------
// Pure decision core. Everything below operates on plain snapshots so the
// behaviour can be driven deterministically from tests without a live turn.
// ---------------------------------------------------------------------------

export function isTerminalTurnState(state: TurnRecordState): boolean {
  return state === 'terminal'
}

/**
 * A turn counts as active until it reaches a terminal event or its completion
 * promise settles. Both are needed: the completion resolves slightly before the
 * terminal event is recorded, and a turn that fails before announcing never
 * produces a terminal event at all.
 */
export function isTurnActive(snapshot: TurnSnapshot): boolean {
  return !isTerminalTurnState(snapshot.state) && !snapshot.completionSettled
}

export function hasActiveTurn(
  snapshots: Iterable<TurnSnapshot>,
  origin?: TurnOrigin,
): boolean {
  for (const snapshot of snapshots) {
    if (origin && snapshot.origin !== origin) continue
    if (isTurnActive(snapshot)) return true
  }
  return false
}

/**
 * Whether opening the overlay should start a fresh conversation. Any turn that
 * has not reached a terminal state — including one still in `initiating`, whose
 * runtime startup is mid-flight — keeps the current session alive.
 */
export function isFreshOverlayOpen(
  snapshots: Iterable<TurnSnapshot>,
  preserveSession: boolean,
): boolean {
  return !preserveSession && !hasActiveTurn(snapshots)
}

/** The overlay streaming affordance is on exactly while an overlay turn is live. */
export function shouldOverlayStream(snapshots: Iterable<TurnSnapshot>): boolean {
  return hasActiveTurn(snapshots, 'overlay')
}

export function decideTurnEventDisposition(
  snapshot: TurnSnapshot | undefined,
): TurnEventDisposition {
  if (!snapshot) return 'drop'
  if (snapshot.state === 'terminal') return 'drop'
  // Deferring while the drain runs is what keeps publication FIFO: the drain
  // awaits persistence between envelopes, and an event delivered live inside one
  // of those gaps would overtake everything still queued behind it. Appending it
  // to the same queue instead lets the drain loop pick it up in arrival order.
  if (snapshot.state === 'initiating' || snapshot.draining) return 'defer'
  return 'deliver'
}

/**
 * Merges the freshly listed pending attachment ids with anything a concurrent
 * capture appended while the listing was in flight. Ids present before the
 * listing but absent from it were associated or discarded and stay dropped.
 */
export function mergePendingAttachmentIds(
  before: readonly string[],
  after: readonly string[],
  listed: readonly string[],
): string[] {
  const merged = [...listed]
  for (const id of after) {
    if (before.includes(id) || merged.includes(id)) continue
    merged.push(id)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Shell: the mutable record and the registry that owns it.
// ---------------------------------------------------------------------------

export interface TurnRecordInput {
  turnId: string
  conversationId: string
  origin: TurnOrigin
  persistConversation: boolean
}

export interface TurnRecordDependencies {
  /**
   * Last-resort abort for a turn whose handle has not attached yet. Wired to
   * `ConversationRuntime.abortTurn`, which can already reach the live
   * TurnController even before `startTurn` resolves.
   */
  fallbackAbort(turnId: string, reason: string): Promise<boolean>
  onClosed(turnId: string): void
}

/**
 * Everything one turn owns: routing context, the abort handle once runtime
 * startup resolves, the streaming buffers, the queue of events that arrived
 * before the renderer was told about the turn, and the scope that tears all of
 * it down exactly once.
 */
export class TurnRecord {
  readonly turnId: string
  readonly conversationId: string
  readonly origin: TurnOrigin
  readonly context: TurnContext
  readonly deferred: TurnEventEnvelope[] = []
  readonly scope: Scope
  assistantText = ''
  reasoningText = ''
  /** Accumulated tool output per activity, mirroring what the renderer appends. */
  readonly toolOutputs = new Map<string, string>()
  #sequence = 0
  #state: TurnRecordState = 'initiating'
  #draining = false
  #abortHandle: TurnAbortHandle | null = null
  #pendingAbortReason: string | null = null
  #completionSettled = false
  readonly #dependencies: TurnRecordDependencies

  constructor(input: TurnRecordInput, dependencies: TurnRecordDependencies) {
    this.turnId = input.turnId
    this.conversationId = input.conversationId
    this.origin = input.origin
    this.context = {
      origin: input.origin,
      persistConversation: input.persistConversation,
    }
    this.#dependencies = dependencies
    this.scope = createScope({ label: `turn:${input.turnId}` })
    this.scope.defer(() => {
      this.#state = 'terminal'
      this.#draining = false
      this.#abortHandle = null
      this.#pendingAbortReason = null
      this.assistantText = ''
      this.reasoningText = ''
      this.toolOutputs.clear()
      this.deferred.length = 0
      this.#dependencies.onClosed(this.turnId)
    })
  }

  get state(): TurnRecordState {
    return this.#state
  }

  get completionSettled(): boolean {
    return this.#completionSettled
  }

  get abortRequested(): boolean {
    return this.#pendingAbortReason !== null
  }

  get draining(): boolean {
    return this.#draining
  }

  snapshot(): TurnSnapshot {
    return {
      turnId: this.turnId,
      conversationId: this.conversationId,
      origin: this.origin,
      state: this.#state,
      completionSettled: this.#completionSettled,
      abortRequested: this.abortRequested,
      hasAbortHandle: this.#abortHandle !== null,
      draining: this.#draining,
    }
  }

  /**
   * Attaches the runtime abort handle. A `requestAbort` that arrived while the
   * turn was still initiating fires here, the moment it becomes possible.
   */
  attachAbort(handle: TurnAbortHandle): void {
    if (this.scope.closed) return
    this.#abortHandle = handle
    const reason = this.#pendingAbortReason
    if (reason === null) return
    this.#pendingAbortReason = null
    void handle.abort(reason).catch((error: unknown) => {
      log.warn('pending abort failed after handle attached', {
        turnId: this.turnId,
        reason,
        error: serializeErrorForLog(error),
      })
    })
  }

  /**
   * Aborts the turn regardless of how far startup has progressed. While the turn
   * is `initiating` this records the intent (so `attachAbort` can fire it) and
   * also asks the runtime directly, which already knows the turn id.
   */
  async requestAbort(reason: string): Promise<boolean> {
    if (isTerminalTurnState(this.#state)) return false
    const handle = this.#abortHandle
    if (handle) return handle.abort(reason)
    this.#pendingAbortReason = reason
    log.info('abort requested before the turn handle attached', {
      turnId: this.turnId,
      reason,
    })
    return this.#dependencies.fallbackAbort(this.turnId, reason)
  }

  markAnnounced(): void {
    if (this.#state === 'initiating') this.#state = 'announced'
  }

  /**
   * Brackets the announcement's replay of {@link deferred}. Events that arrive
   * while it is open keep being queued so the drain loop publishes them behind
   * whatever is already waiting, instead of jumping the queue during one of the
   * drain's own awaits.
   */
  beginDrain(): void {
    if (!this.scope.closed) this.#draining = true
  }

  endDrain(): void {
    this.#draining = false
  }

  markStreaming(): void {
    if (this.#state === 'initiating' || this.#state === 'announced') {
      this.#state = 'streaming'
    }
  }

  markCompletionSettled(): void {
    this.#completionSettled = true
  }

  appendAssistantText(text: string): string {
    this.assistantText += text
    return this.assistantText
  }

  appendReasoningText(text: string): string {
    this.reasoningText += text
    return this.reasoningText
  }

  appendToolOutput(activityId: string, text: string): void {
    const current = this.toolOutputs.get(activityId)
    const merged = current === undefined ? text : `${current}${text}`
    this.toolOutputs.set(
      activityId,
      merged.length > MAX_SNAPSHOT_TOOL_OUTPUT_CHARS
        ? merged.slice(merged.length - MAX_SNAPSHOT_TOOL_OUTPUT_CHARS)
        : merged,
    )
    // Insertion order is oldest-first, so the oldest activity is dropped once the
    // snapshot contract's array bound would be exceeded.
    while (this.toolOutputs.size > MAX_SNAPSHOT_TOOL_ACTIVITIES) {
      const oldest = this.toolOutputs.keys().next()
      if (oldest.done) break
      this.toolOutputs.delete(oldest.value)
    }
  }

  /**
   * Claims the next sequence number. Called once per PUBLISHED turn-scoped
   * event, so the numbers a renderer observes are contiguous and a jump can only
   * mean the transport dropped something.
   */
  nextSequence(): number {
    this.#sequence += 1
    return this.#sequence
  }

  get latestSequence(): number {
    return this.#sequence
  }

  /** The authoritative transcript for this turn, used to answer a re-sync. */
  transcriptSnapshot(): TranscriptSnapshot {
    return {
      turnId: this.turnId,
      sessionId: this.conversationId,
      origin: this.origin,
      sequence: this.#sequence,
      answer: this.assistantText,
      reasoning: this.reasoningText,
      toolOutputs: [...this.toolOutputs].map(([activityId, text]) => ({ activityId, text })),
      live: !isTerminalTurnState(this.#state),
    }
  }

  /** Runs every finalizer exactly once and removes the record from the registry. */
  close(reason?: string): Promise<void> {
    return this.scope.close(reason)
  }
}

export interface TurnRegistryOptions {
  fallbackAbort?(turnId: string, reason: string): Promise<boolean>
}

/**
 * The single owner of per-turn state in the main process. Records are created
 * synchronously so id-free abort paths and the overlay fresh-session check can
 * see a turn whose runtime startup is still in flight.
 */
export class TurnRegistry {
  readonly #records = new Map<string, TurnRecord>()
  readonly #fallbackAbort: NonNullable<TurnRegistryOptions['fallbackAbort']>

  constructor(options: TurnRegistryOptions = {}) {
    this.#fallbackAbort = options.fallbackAbort ?? (async () => false)
  }

  get size(): number {
    return this.#records.size
  }

  register(input: TurnRecordInput): TurnRecord {
    if (this.#records.has(input.turnId)) {
      throw new Error(`Turn is already registered: ${input.turnId}`)
    }
    const record = new TurnRecord(input, {
      fallbackAbort: (turnId, reason) => this.#fallbackAbort(turnId, reason),
      onClosed: (turnId) => {
        if (this.#records.get(turnId) === record) this.#records.delete(turnId)
      },
    })
    this.#records.set(input.turnId, record)
    return record
  }

  get(turnId: string): TurnRecord | undefined {
    return this.#records.get(turnId)
  }

  snapshots(): TurnSnapshot[] {
    return [...this.#records.values()].map((record) => record.snapshot())
  }

  records(): TurnRecord[] {
    return [...this.#records.values()]
  }

  hasActive(origin?: TurnOrigin): boolean {
    return hasActiveTurn(this.snapshots(), origin)
  }

  /** Aborts every non-terminal record the predicate selects. */
  async requestAbortWhere(
    predicate: (snapshot: TurnSnapshot) => boolean,
    reason: string,
  ): Promise<void> {
    await Promise.all(
      this.records()
        .filter((record) => !isTerminalTurnState(record.state) && predicate(record.snapshot()))
        .map((record) =>
          record.requestAbort(reason).catch((error: unknown) => {
            log.warn('abort request failed', {
              turnId: record.turnId,
              reason,
              error: serializeErrorForLog(error),
            })
            return false
          }),
        ),
    )
  }

  async closeAll(reason?: string): Promise<void> {
    await Promise.all(this.records().map((record) => record.close(reason)))
    this.#records.clear()
  }
}
