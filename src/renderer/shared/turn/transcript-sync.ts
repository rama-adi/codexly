import type { TranscriptSnapshot } from '../../../shared/ipc/product'

/**
 * Gap detection and recovery for the turn event stream, shared by both
 * renderers.
 *
 * The main process stamps every turn-scoped event it publishes with a per-turn
 * monotonic sequence, so a consumer can tell the difference between "the stream
 * ended here" and "the transport dropped part of the stream". Whenever the
 * numbers are not contiguous — a preload eviction, a `transcript.gap` marker, or
 * joining a turn that was already streaming — the accumulated local transcript
 * is untrustworthy and is replaced wholesale by the authoritative main-side
 * snapshot, after which delta application resumes from the snapshot's sequence.
 */

export type SequenceDecision =
  /** Contiguous (or unsequenced): the consumer should apply the event. */
  | 'apply'
  /** Already applied — a replayed buffer entry. Applying again would double text. */
  | 'duplicate'
  /** Something is missing; a re-sync is running and the event must be skipped. */
  | 'gap'

export interface TranscriptSyncOptions {
  fetchSnapshot(turnId: string): Promise<TranscriptSnapshot | null>
  /** Replace the local transcript with the authoritative copy. */
  applySnapshot(snapshot: TranscriptSnapshot): void
  onError?(message: string): void
}

/** How many turns keep a sequence watermark; older ones are pruned. */
const MAX_TRACKED_TURNS = 32

/** The shape of any turn-scoped event the transport stamps. */
export interface SequencedEvent {
  turnId: string
  sequence?: number
}

export interface TranscriptSync {
  /**
   * The gate a consumer puts in front of a streaming event: true only when the
   * event is the next one in line, so a replay is skipped and a hole triggers a
   * re-sync instead of being papered over by appending.
   */
  gate(event: SequencedEvent): boolean
  /**
   * Continuity bookkeeping for an event whose payload a snapshot CANNOT restore —
   * a tool activity's identity and state, which the snapshot contract does not
   * carry. A hole still starts a re-sync, but such an event is NEVER skipped and
   * so has no gate: nothing later recreates the activity row, so dropping it
   * (as a suspected replay, or because a re-sync is in flight) would lose it for
   * good. Re-applying it is harmless because the consumer replaces the row by key.
   */
  noteUnrecoverable(event: SequencedEvent): void
  /**
   * Applies a terminal event, which is NEVER skipped — the turn machine has to
   * settle either way — but waits for an outstanding re-sync first so the final
   * transcript is the authoritative one.
   */
  settleTerminal(event: SequencedEvent, apply: () => void): void
  classify(turnId: string, sequence: number | undefined): SequenceDecision
  /** Records that the consumer applied everything up to `sequence`. */
  commit(turnId: string, sequence: number | undefined): void
  /** Force a re-sync (used for the preload's `transcript.gap` marker). */
  noteGap(turnId: string): void
  /** Whether a re-sync for this turn is running or queued. */
  pending(turnId: string): boolean
  /** Resolves once no re-sync for this turn is outstanding. */
  settled(turnId: string): Promise<void>
  forget(turnId: string): void
}

export function createTranscriptSync(options: TranscriptSyncOptions): TranscriptSync {
  const applied = new Map<string, number>()
  const inFlight = new Map<string, Promise<void>>()
  const dirty = new Set<string>()

  const remember = (turnId: string, sequence: number) => {
    const current = applied.get(turnId)
    applied.delete(turnId)
    applied.set(turnId, current === undefined ? sequence : Math.max(current, sequence))
    while (applied.size > MAX_TRACKED_TURNS) {
      const oldest = applied.keys().next()
      if (oldest.done) break
      applied.delete(oldest.value)
    }
  }

  const resync = async (turnId: string): Promise<void> => {
    try {
      const snapshot = await options.fetchSnapshot(turnId)
      // A turn the main process no longer knows cannot be recovered; the
      // consumer keeps what it has rather than blanking a visible transcript.
      if (!snapshot) return
      remember(turnId, snapshot.sequence)
      options.applySnapshot(snapshot)
    } catch (error) {
      options.onError?.(
        error instanceof Error && error.message
          ? error.message
          : 'Part of the response was lost and could not be recovered.',
      )
    }
  }

  const start = (turnId: string): void => {
    if (inFlight.has(turnId)) {
      // Events that arrive while a re-sync is in flight are not covered by the
      // snapshot already being fetched, so one more pass is queued.
      dirty.add(turnId)
      return
    }
    const run = (async () => {
      do {
        dirty.delete(turnId)
        await resync(turnId)
      } while (dirty.has(turnId))
    })().finally(() => {
      inFlight.delete(turnId)
    })
    inFlight.set(turnId, run)
  }

  const sync: TranscriptSync = {
    gate(event) {
      if (sync.classify(event.turnId, event.sequence) !== 'apply') return false
      sync.commit(event.turnId, event.sequence)
      return true
    },

    noteUnrecoverable(event) {
      if (sync.classify(event.turnId, event.sequence) === 'apply') {
        sync.commit(event.turnId, event.sequence)
      }
    },

    settleTerminal(event, apply) {
      const decision = sync.classify(event.turnId, event.sequence)
      const finish = () => {
        sync.commit(event.turnId, event.sequence)
        apply()
        sync.forget(event.turnId)
      }
      if (decision === 'gap' || sync.pending(event.turnId)) {
        void sync.settled(event.turnId).then(finish)
        return
      }
      finish()
    },

    classify(turnId, sequence) {
      if (sequence === undefined) return 'apply'
      if (inFlight.has(turnId)) {
        dirty.add(turnId)
        return 'gap'
      }
      const last = applied.get(turnId)
      // An unseen turn is expected to start at 1: a higher first sequence means
      // the consumer joined the stream late and never saw the beginning.
      const expected = last === undefined ? 1 : last + 1
      if (last !== undefined && sequence <= last) return 'duplicate'
      if (sequence <= expected) return 'apply'
      start(turnId)
      return 'gap'
    },

    commit(turnId, sequence) {
      if (sequence === undefined) return
      remember(turnId, sequence)
    },

    noteGap(turnId) {
      start(turnId)
    },

    pending(turnId) {
      return inFlight.has(turnId)
    },

    async settled(turnId) {
      await inFlight.get(turnId)
    },

    forget(turnId) {
      applied.delete(turnId)
      dirty.delete(turnId)
    },
  }
  return sync
}
