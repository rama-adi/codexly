/**
 * Deterministic harness for the main-process turn lifecycle.
 *
 * It replays the exact sequence `ProductController` performs around
 * `TurnRegistry` — synchronous registration, awaited runtime startup,
 * `attachAbort`, the deferred-event announcement, the terminal event that closes
 * the record, and the id-free abort paths behind session reset / delete /
 * `attachments.clear` / a fresh overlay open — while every await point is a
 * manually resolved deferred. A generated action list therefore fixes the
 * interleaving completely: the same list always produces the same schedule, with
 * no timers and no reliance on microtask luck.
 *
 * This file contains ZERO lifecycle logic of its own. It only drives
 * `turn-registry.ts` and the pure decision functions, and records what it
 * observed so the property suites can check invariants over it.
 */

import type { TranscriptSnapshot, TurnOrigin } from '../../src/shared/ipc/product'
import type { TurnEventEnvelope } from '../conversation/turn-controller'
import {
  announceTurnBeforeDeferredEvents,
  retainTranscriptSnapshot,
} from './product-controller'
import {
  decideTurnEventDisposition,
  isFreshOverlayOpen,
  shouldOverlayStream,
  TurnRegistry,
  type TurnAbortHandle,
  type TurnRecord,
  type TurnSnapshot,
} from './turn-registry'

// ---------------------------------------------------------------------------
// Manually settled deferreds
// ---------------------------------------------------------------------------

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly settled: boolean
  resolve(value: T): void
  reject(error: unknown): void
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  let rejectFn: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  // The rejection is always consumed by the harness job that awaits it, but the
  // job may not have reached its await yet when reject fires.
  promise.catch(() => undefined)
  let settled = false
  return {
    promise,
    get settled() {
      return settled
    },
    resolve(value) {
      if (settled) return
      settled = true
      resolveFn(value)
    },
    reject(error) {
      if (settled) return
      settled = true
      rejectFn(error)
    },
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type TerminalEventType = 'turn.completed' | 'turn.interrupted' | 'turn.failed'

/**
 * The user-facing and runtime-facing operations. `turn` is a slot selector that
 * the harness reduces modulo the number of started turns, so an action list can
 * be generated without dependent arbitraries and still always addresses a real
 * turn once one exists.
 */
export type LifecycleAction =
  | { type: 'send'; origin: TurnOrigin; sessionId: string; persistConversation: boolean }
  | { type: 'resolveStartup'; turn: number }
  | { type: 'rejectStartup'; turn: number }
  | { type: 'announce'; turn: number }
  | { type: 'streamEvent'; turn: number }
  | { type: 'toolOutput'; turn: number }
  | { type: 'terminalEvent'; turn: number; event: TerminalEventType }
  | { type: 'settleCompletion'; turn: number }
  | { type: 'stop'; turn: number }
  | { type: 'openOverlay'; preserveSession: boolean }
  | { type: 'clearAttachments' }
  | { type: 'resetSession' }
  | { type: 'deleteSession'; sessionId: string }
  /** `ProductController.dispose`: closes every record, overlapping other closes. */
  | { type: 'dispose' }
  | { type: 'flush' }

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface PublishedEvent {
  turnId: string
  sessionId: string
  origin: TurnOrigin
  sequence: number
  type: string
}

export interface DroppedEvent {
  turnId: string
  type: string
  reason: 'no-record' | 'terminal-record'
}

export interface AbortCall {
  turnId: string
  reason: string
  via: 'handle' | 'fallback'
}

/** One session-teardown observation, checked by the no-stranded-turn invariant. */
export interface SessionTeardown {
  kind: 'clear-active' | 'delete'
  sessionId: string | null
  snapshots: TurnSnapshot[]
  strandedTurnIds: string[]
}

export interface TurnSlot {
  readonly turnId: string
  readonly sessionId: string
  readonly origin: TurnOrigin
  readonly persistConversation: boolean
  readonly record: TurnRecord
  readonly startup: Deferred<TurnAbortHandle>
  readonly completion: Deferred<void>
  readonly handleAborts: string[]
  readonly fallbackAborts: string[]
  startupOutcome: 'pending' | 'resolved' | 'rejected'
  announced: boolean
  /** The last reason requested while no handle existed, i.e. an abort owed to `attachAbort`. */
  abortOwedOnAttach: string | null
  /** Whether the record was already closed when the handle attached. */
  closedBeforeAttach: boolean
  finalizerRuns: number
  closed: boolean
  /** Deferred events still queued when the record was torn down. */
  discardedDeferred: number
}

export interface HarnessOptions {
  /** What `ConversationRuntime.abortTurn` reports for a turn with no handle yet. */
  fallbackAbortSucceeds?: boolean
  /** Makes `windowManager.setOverlayStreaming` reject, as it can in production. */
  overlayStreamingFails?: boolean
  retainedSnapshotLimit?: number
}

export class TurnLifecycleHarness {
  readonly registry: TurnRegistry
  readonly slots: TurnSlot[] = []
  readonly published: PublishedEvent[] = []
  readonly dropped: DroppedEvent[] = []
  readonly aborts: AbortCall[] = []
  readonly teardowns: SessionTeardown[] = []
  readonly retained = new Map<string, TranscriptSnapshot>()
  readonly overlayStreaming: boolean[] = []
  readonly violations: string[] = []
  /** Every envelope handed to the event entry point, for the accounting check. */
  enqueuedEvents = 0
  /** How many times a fresh overlay open dropped the active session. */
  clearActiveCount = 0
  /** How many deferred envelopes were replayed by an announcement. */
  drainedDeferredCount = 0
  disposeCount = 0
  #nextTurn = 0
  #nextEvent = 0
  readonly #jobs: Array<Promise<unknown>> = []
  readonly #options: HarnessOptions

  constructor(options: HarnessOptions = {}) {
    this.#options = options
    this.registry = new TurnRegistry({
      fallbackAbort: async (turnId, reason) => {
        this.aborts.push({ turnId, reason, via: 'fallback' })
        this.#slotOf(turnId)?.fallbackAborts.push(reason)
        return options.fallbackAbortSucceeds ?? false
      },
    })
  }

  #slotOf(turnId: string): TurnSlot | undefined {
    return this.slots.find((slot) => slot.turnId === turnId)
  }

  #resolveSlot(selector: number): TurnSlot | null {
    if (this.slots.length === 0) return null
    const index = ((selector % this.slots.length) + this.slots.length) % this.slots.length
    return this.slots[index]
  }

  #fail(message: string): void {
    this.violations.push(message)
  }

  // -------------------------------------------------------------------------
  // ProductController mirrors
  // -------------------------------------------------------------------------

  /** Mirrors `#publish` for a turn-scoped event. */
  #publish(event: PublishedEvent): void {
    this.published.push(event)
  }

  /** Mirrors `#syncOverlayStreaming`, including its swallowed rejection. */
  async #syncOverlayStreaming(): Promise<void> {
    const streaming = shouldOverlayStream(this.registry.snapshots())
    this.overlayStreaming.push(streaming)
    if (this.#options.overlayStreamingFails) {
      await Promise.reject(new Error('overlay streaming transition failed')).catch(
        () => undefined,
      )
    }
  }

  /** Mirrors `#send`: synchronous registration, then awaited runtime startup. */
  #send(action: Extract<LifecycleAction, { type: 'send' }>): TurnSlot {
    const turnId = `turn-${this.#nextTurn++}`
    const record = this.registry.register({
      turnId,
      conversationId: action.sessionId,
      origin: action.origin,
      persistConversation: action.persistConversation,
    })
    const slot: TurnSlot = {
      turnId,
      sessionId: action.sessionId,
      origin: action.origin,
      persistConversation: action.persistConversation,
      record,
      startup: createDeferred<TurnAbortHandle>(),
      completion: createDeferred<void>(),
      handleAborts: [],
      fallbackAborts: [],
      startupOutcome: 'pending',
      announced: false,
      abortOwedOnAttach: null,
      closedBeforeAttach: false,
      finalizerRuns: 0,
      closed: false,
      discardedDeferred: 0,
    }
    // Registered last so it pops first: the built-in finalizer clears `deferred`,
    // and the count of discarded events must be read before that happens.
    record.scope.defer(() => {
      slot.finalizerRuns += 1
      slot.discardedDeferred += record.deferred.length
      slot.closed = true
    })
    this.slots.push(slot)
    this.#jobs.push(this.#runStartup(slot))
    return slot
  }

  async #runStartup(slot: TurnSlot): Promise<void> {
    const { record } = slot
    try {
      const handle = await slot.startup.promise
      slot.startupOutcome = 'resolved'
      slot.closedBeforeAttach = record.scope.closed
      record.attachAbort(handle)
    } catch {
      slot.startupOutcome = 'rejected'
      // Mirrors the `#send` catch: abort whatever startup may have created, then
      // run the single cleanup path.
      await record.requestAbort('Turn setup failed').catch(() => false)
      await record.close('Turn setup failed')
      await this.#syncOverlayStreaming()
      return
    }
    await this.#syncOverlayStreaming()
    this.#jobs.push(
      slot.completion.promise.finally(() => {
        record.markCompletionSettled()
        void this.#syncOverlayStreaming()
      }),
    )
  }

  /**
   * Mirrors `#stop`. A stop for a turn whose record is gone falls through to the
   * runtime in production; there is nothing left for the registry to do, so the
   * harness stops at reporting the miss.
   */
  async #stop(slot: TurnSlot): Promise<boolean> {
    if (!this.registry.get(slot.turnId)) return false
    return this.#requestAbort(slot, 'Stopped by user')
  }

  /**
   * Wraps `record.requestAbort` so the harness can tell an abort that had to
   * wait for `attachAbort` from one that reached a live handle.
   */
  async #requestAbort(slot: TurnSlot, reason: string): Promise<boolean> {
    const before = slot.record.snapshot()
    if (!before.hasAbortHandle && before.state !== 'terminal') {
      slot.abortOwedOnAttach = reason
    }
    return slot.record.requestAbort(reason).catch(() => false)
  }

  /** Mirrors `#abortTurnsForSession` / `#abortOverlayTurns`. */
  async #requestAbortWhere(
    predicate: (snapshot: TurnSnapshot) => boolean,
    reason: string,
  ): Promise<void> {
    for (const slot of this.slots) {
      const record = this.registry.get(slot.turnId)
      if (!record || record.state === 'terminal') continue
      if (!predicate(record.snapshot())) continue
      slot.abortOwedOnAttach = record.snapshot().hasAbortHandle ? slot.abortOwedOnAttach : reason
    }
    await this.registry.requestAbortWhere(predicate, reason)
    await this.#syncOverlayStreaming()
  }

  /**
   * Mirrors `openOverlay`. `clearActive` is the destructive step: it drops the
   * active session (and, in ephemeral mode, the whole session record) out from
   * under whatever is registered.
   */
  async #openOverlay(preserveSession: boolean): Promise<void> {
    const snapshots = this.registry.snapshots()
    if (isFreshOverlayOpen(snapshots, preserveSession)) {
      this.clearActiveCount += 1
      this.#recordTeardown('clear-active', null, snapshots)
    }
    await this.#syncOverlayStreaming()
  }

  /** Mirrors `#deleteSession`: abort every turn of the session, then delete it. */
  async #deleteSession(sessionId: string): Promise<void> {
    await this.#requestAbortWhere((snapshot) => snapshot.conversationId === sessionId, 'Session deleted by user')
    this.#recordTeardown('delete', sessionId, this.registry.snapshots())
  }

  #recordTeardown(
    kind: SessionTeardown['kind'],
    sessionId: string | null,
    snapshots: TurnSnapshot[],
  ): void {
    const scoped = snapshots.filter(
      (snapshot) => sessionId === null || snapshot.conversationId === sessionId,
    )
    const stranded = scoped
      .filter((snapshot) => {
        if (snapshot.state === 'terminal') return false
        if (kind === 'clear-active') {
          // A fresh open aborts nothing, so any turn that has not finished is
          // stranded by the clear.
          return !snapshot.completionSettled
        }
        // A delete may leave a non-terminal record behind, but only one it has
        // already asked to abort.
        const slot = this.#slotOf(snapshot.turnId)
        return (slot?.handleAborts.length ?? 0) + (slot?.fallbackAborts.length ?? 0) === 0
      })
      .map((snapshot) => snapshot.turnId)
    this.teardowns.push({ kind, sessionId, snapshots: scoped, strandedTurnIds: stranded })
  }

  #envelope(slot: TurnSlot, event: TurnEventEnvelope['event']): TurnEventEnvelope {
    this.#nextEvent += 1
    return {
      conversationId: slot.sessionId,
      turnId: slot.turnId,
      sequence: this.#nextEvent,
      occurredAt: new Date(0).toISOString(),
      event,
    }
  }

  /** Mirrors `#recordTurnEvent`: the defer / drop / deliver decision. */
  async #recordTurnEvent(envelope: TurnEventEnvelope): Promise<void> {
    this.enqueuedEvents += 1
    const record = this.registry.get(envelope.turnId)
    switch (decideTurnEventDisposition(record?.snapshot())) {
      case 'defer':
        record?.deferred.push(envelope)
        return
      case 'drop':
        this.dropped.push({
          turnId: envelope.turnId,
          type: envelope.event.type,
          reason: record ? 'terminal-record' : 'no-record',
        })
        return
      case 'deliver':
        await this.#recordTurnEventNow(envelope)
    }
  }

  /** Mirrors `#recordTurnEventNow` for the event kinds that carry an origin. */
  async #recordTurnEventNow(envelope: TurnEventEnvelope): Promise<void> {
    const { conversationId: sessionId, turnId, event } = envelope
    const record = this.registry.get(turnId)
    if (!record) {
      this.dropped.push({ turnId, type: event.type, reason: 'no-record' })
      return
    }
    const { origin } = record.context
    if (event.type === 'assistant.delta') {
      record.markStreaming()
      record.appendAssistantText(event.text)
      this.#publish({
        turnId,
        sessionId,
        origin,
        sequence: record.nextSequence(),
        type: 'transcript.delta',
      })
      return
    }
    if (event.type === 'activity.output') {
      record.markStreaming()
      record.appendToolOutput(event.activityId, event.text)
      this.#publish({
        turnId,
        sessionId,
        origin,
        sequence: record.nextSequence(),
        type: 'tool.output',
      })
      return
    }
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.interrupted' ||
      event.type === 'turn.failed'
    ) {
      try {
        this.#publish({
          turnId,
          sessionId,
          origin,
          sequence: record.nextSequence(),
          type: event.type === 'turn.failed' ? 'transcript.failed' : 'transcript.complete',
        })
      } finally {
        retainTranscriptSnapshot(
          this.retained,
          record.transcriptSnapshot(),
          this.#options.retainedSnapshotLimit,
        )
        await record.close(`turn ${event.type}`)
        await this.#syncOverlayStreaming()
      }
    }
  }

  /**
   * Mirrors `#announceAndActivateTurn`. `#sendFromSurface` reaches it only after
   * `#send` resolved, and exactly once per turn, so the harness gates on both.
   * `conversation.started` carries no sequence in the contract, hence 0 here.
   */
  async #announce(slot: TurnSlot): Promise<void> {
    if (slot.startupOutcome !== 'resolved' || slot.announced) return
    slot.announced = true
    const record = this.registry.get(slot.turnId)
    if (!record) return
    record.beginDrain()
    try {
      await announceTurnBeforeDeferredEvents(
        () => {
          this.#publish({
            turnId: slot.turnId,
            sessionId: slot.sessionId,
            origin: record.context.origin,
            sequence: 0,
            type: 'conversation.started',
          })
          record.markAnnounced()
        },
        record.deferred,
        (envelope) => {
          this.drainedDeferredCount += 1
          return this.#recordTurnEventNow(envelope)
        },
      )
    } finally {
      record.endDrain()
    }
  }

  // -------------------------------------------------------------------------
  // Driver
  // -------------------------------------------------------------------------

  async apply(action: LifecycleAction): Promise<void> {
    switch (action.type) {
      case 'send':
        this.#send(action)
        break
      case 'resolveStartup': {
        const slot = this.#resolveSlot(action.turn)
        if (slot) slot.startup.resolve(this.#abortHandleFor(slot))
        break
      }
      case 'rejectStartup':
        this.#resolveSlot(action.turn)?.startup.reject(new Error('runtime startup failed'))
        break
      case 'announce': {
        const slot = this.#resolveSlot(action.turn)
        if (slot) await this.#announce(slot)
        break
      }
      case 'streamEvent': {
        const slot = this.#resolveSlot(action.turn)
        if (slot) {
          await this.#recordTurnEvent(
            this.#envelope(slot, { type: 'assistant.delta', text: 'chunk' }),
          )
        }
        break
      }
      case 'toolOutput': {
        const slot = this.#resolveSlot(action.turn)
        if (slot) {
          await this.#recordTurnEvent(
            this.#envelope(slot, {
              type: 'activity.output',
              activityId: 'activity-1',
              text: 'out',
              preliminary: false,
            }),
          )
        }
        break
      }
      case 'terminalEvent': {
        const slot = this.#resolveSlot(action.turn)
        if (!slot) break
        await this.#recordTurnEvent(
          this.#envelope(
            slot,
            action.event === 'turn.failed'
              ? { type: 'turn.failed', message: 'provider failed' }
              : action.event === 'turn.interrupted'
                ? { type: 'turn.interrupted', reason: 'interrupted' }
                : { type: 'turn.completed' },
          ),
        )
        break
      }
      case 'settleCompletion':
        this.#resolveSlot(action.turn)?.completion.resolve()
        break
      case 'stop': {
        const slot = this.#resolveSlot(action.turn)
        if (slot) await this.#stop(slot)
        break
      }
      case 'openOverlay':
        await this.#openOverlay(action.preserveSession)
        break
      case 'clearAttachments':
        await this.#requestAbortWhere((snapshot) => snapshot.origin === 'overlay', 'Cleared by user')
        break
      case 'resetSession':
        await this.#requestAbortWhere(
          (snapshot) => snapshot.origin === 'overlay',
          'Session reset by user',
        )
        break
      case 'deleteSession':
        await this.#deleteSession(action.sessionId)
        break
      case 'dispose':
        this.disposeCount += 1
        // Deliberately not awaited before the terminal path can also close the
        // same records: dispose racing a settling turn is the real overlap.
        this.#jobs.push(this.registry.closeAll('Product controller disposed'))
        break
      case 'flush':
        break
    }
    // Every action ends at a scheduling point, so a job whose deferred just
    // settled runs its continuation before the next action is applied.
    await this.flush()
    this.#checkStepInvariants()
  }

  async run(actions: readonly LifecycleAction[]): Promise<void> {
    for (const action of actions) {
      await this.apply(action)
    }
  }

  /** Drains the microtask queue. No timers are involved anywhere in the harness. */
  async flush(rounds = 6): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await Promise.resolve()
    }
  }

  /**
   * Settles everything the generated list left hanging — the way a real shutdown
   * does — so the end-state invariants describe a quiesced registry.
   */
  async settle(): Promise<void> {
    for (const slot of this.slots) slot.startup.resolve(this.#abortHandleFor(slot))
    await this.flush()
    // A successful send always reaches the announcement; replay the ones the
    // action list stopped short of.
    for (const slot of this.slots) await this.#announce(slot)
    for (const slot of this.slots) slot.completion.resolve()
    await this.flush()
    // The runtime always emits a terminal event for a turn it started; replay the
    // ones the action list did not.
    for (const slot of this.slots) {
      if (!this.registry.get(slot.turnId)) continue
      await this.#recordTurnEvent(this.#envelope(slot, { type: 'turn.completed' }))
    }
    await Promise.all(this.#jobs)
    await this.flush()
    this.#checkStepInvariants()
  }

  #abortHandleFor(slot: TurnSlot): TurnAbortHandle {
    return {
      abort: async (reason?: string) => {
        const resolved = reason ?? 'aborted'
        this.aborts.push({ turnId: slot.turnId, reason: resolved, via: 'handle' })
        slot.handleAborts.push(resolved)
        return true
      },
    }
  }

  /** Checks the invariants that must hold after every single step. */
  #checkStepInvariants(): void {
    for (const slot of this.slots) {
      if (slot.finalizerRuns > 1) {
        this.#fail(`${slot.turnId}: finalizers ran ${slot.finalizerRuns} times`)
      }
      if (slot.closed && this.registry.get(slot.turnId)) {
        this.#fail(`${slot.turnId}: record stayed in the registry after teardown`)
      }
    }
    for (const teardown of this.teardowns) {
      if (teardown.strandedTurnIds.length > 0) {
        this.#fail(
          `${teardown.kind} of ${teardown.sessionId ?? 'active session'} stranded live turns: ${teardown.strandedTurnIds.join(', ')}`,
        )
      }
    }
    this.teardowns.length = 0
    for (const event of this.published) {
      const slot = this.#slotOf(event.turnId)
      if (!slot) {
        this.#fail(`published an event for an unknown turn ${event.turnId}`)
      } else if (event.origin !== slot.origin) {
        this.#fail(
          `${event.turnId}: published '${event.type}' as origin '${event.origin}', registered '${slot.origin}'`,
        )
      }
    }
  }

  /**
   * Per-turn published sequence numbers, in publication order. Events the
   * contract leaves sequence-less (`conversation.started`) are excluded.
   */
  sequencesFor(turnId: string): number[] {
    return this.published
      .filter((event) => event.turnId === turnId && event.sequence > 0)
      .map((event) => event.sequence)
  }
}
