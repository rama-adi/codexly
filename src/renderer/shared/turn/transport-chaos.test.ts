import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { ProductEvent, TranscriptSnapshot, TurnOrigin } from '../../../shared/ipc/product'
import { createConversationStore } from '../../homepage/store/conversation-store'
import { createOverlayStore } from '../../overlay/store/overlay-store'
import { createTranscriptSync } from './transcript-sync'

/**
 * Property/chaos suite for the EVENT TRANSPORT's continuity protocol.
 *
 * The main process stamps every turn-scoped event it publishes with a contiguous
 * per-turn sequence and retains the authoritative transcript so it can answer
 * `conversation.transcriptSnapshot` at any point (see
 * `electron/app/turn-registry.ts`). These tests put an adversarial channel
 * between the two: events are dropped, duplicated, reordered inside a bounded
 * window, and preceded by the preload's `transcript.gap` eviction marker.
 *
 * The consumer under test is the real pair used by both renderers:
 * `createTranscriptSync` (gap detection + snapshot re-sync) driving the real
 * overlay store. `handleProductEvent` below mirrors the switch in
 * `overlay/hooks/useProductEventBridge.ts` — dispatch first, then gate — because
 * the hook itself is only reachable through React; every decision it delegates
 * (acceptance, gating, snapshot application) is exercised by the real modules.
 *
 * Two things must hold no matter what the channel does:
 *   1. the transcript is never SILENTLY WRONG — at every step the rendered text
 *      is a prefix of the ground truth, and once the turn settles it is equal to
 *      it, so a hole is always either detected or repaired;
 *   2. the terminal event always settles, even when it lands mid-re-sync, and the
 *      number of re-syncs stays bounded (no snapshot storm).
 */

const SESSION = 'session-1'
const TURN = 'turn-1'
const ORIGIN = 'overlay' as const

// ---------------------------------------------------------------------------
// Ground truth: what the main process published, and what it would answer a
// snapshot request with at a given point in the stream.
// ---------------------------------------------------------------------------

interface Published {
  readonly sequence: number
  readonly event: ProductEvent
}

interface MainTranscript {
  readonly answer: string
  readonly reasoning: string
  readonly toolOutputs: { activityId: string; text: string }[]
}

/**
 * The authoritative transcript through `through`, i.e. exactly what
 * `TurnRecord.transcriptSnapshot()` returns once it has published that many
 * events: the main process accumulates the text of every event it publishes.
 */
function accumulate(published: readonly Published[], through: number): MainTranscript {
  let answer = ''
  let reasoning = ''
  const toolOutputs = new Map<string, string>()
  for (const { sequence, event } of published) {
    if (sequence > through) break
    if (event.type === 'transcript.delta') answer += event.text
    else if (event.type === 'transcript.reasoning') reasoning += event.text
    else if (event.type === 'tool.output') {
      toolOutputs.set(event.activityId, (toolOutputs.get(event.activityId) ?? '') + event.text)
    }
  }
  return {
    answer,
    reasoning,
    toolOutputs: [...toolOutputs].map(([activityId, text]) => ({ activityId, text })),
  }
}

function snapshotAt(
  published: readonly Published[],
  through: number,
  origin: TurnOrigin = ORIGIN,
): TranscriptSnapshot {
  const transcript = accumulate(published, through)
  return {
    turnId: TURN,
    sessionId: SESSION,
    origin,
    sequence: through,
    answer: transcript.answer,
    reasoning: transcript.reasoning,
    toolOutputs: transcript.toolOutputs,
    live: true,
  }
}

function gapMarker(evictedThrough: number, droppedCount = 1): ProductEvent {
  return {
    type: 'transcript.gap',
    sessionId: SESSION,
    turnId: TURN,
    origin: ORIGIN,
    evictedThrough,
    droppedCount,
  }
}

// ---------------------------------------------------------------------------
// Consumer: the real store + the real transcript sync, wired exactly as the
// overlay bridge wires them.
// ---------------------------------------------------------------------------

function createConsumer(fetchSnapshot: (turnId: string) => Promise<TranscriptSnapshot | null>) {
  const store = createOverlayStore({ transport: { stopTurn: async () => true } })
  const errors: string[] = []
  let snapshotsApplied = 0
  let terminalSettled = false

  const state = () => store.getState()

  const sync = createTranscriptSync({
    fetchSnapshot,
    applySnapshot: (snapshot) => {
      const turn = state().turn
      if (turn.phase !== 'active' || turn.scope.turnId !== snapshot.turnId) return
      snapshotsApplied += 1
      state().replaceTranscript({ answer: snapshot.answer, reasoning: snapshot.reasoning })
      state().replaceToolOutputs(snapshot.toolOutputs)
    },
    onError: (message) => errors.push(message),
  })

  const handleProductEvent = (event: ProductEvent): void => {
    if ('origin' in event && event.origin === 'homepage') return

    switch (event.type) {
      case 'conversation.started': {
        const kind = event.consumedAttachmentIds.length ? 'solve' : 'chat'
        const { accepted, freshStart } = state().dispatch({
          type: 'started',
          kind,
          sessionId: event.sessionId,
          turnId: event.turnId,
        })
        if (!accepted) return
        if (freshStart) {
          state().resetTranscript()
          state().clearActivities()
        }
        state().setSessionId(event.sessionId)
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
        state().appendTranscript({ answer: event.text })
        return
      }

      case 'tool.status': {
        const { accepted } = state().dispatch({
          type: 'streamEvent',
          sessionId: event.sessionId,
          turnId: event.turnId,
        })
        if (!accepted) return
        sync.noteUnrecoverable(event)
        state().applyToolStatus({
          activityId: event.activityId,
          name: event.name,
          state: event.state,
          detail: event.detail,
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

      case 'transcript.complete': {
        sync.settleTerminal(event, () => {
          terminalSettled = true
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
    }
  }

  return {
    store,
    sync,
    errors,
    handleProductEvent,
    get snapshotsApplied() {
      return snapshotsApplied
    },
    get terminalSettled() {
      return terminalSettled
    },
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// The adversarial channel
// ---------------------------------------------------------------------------

type SpecKind = 'delta' | 'reasoning' | 'toolStatus' | 'toolOutput'

interface StreamPlan {
  readonly kind: SpecKind
  readonly activity: number
  /** Rolls are `nat`s so shrinking always heads towards a clean channel. */
  readonly dropRoll: number
  readonly duplicateRoll: number
  readonly markerRoll: number
  readonly jitter: number
  readonly pauseRoll: number
}

const streamPlanArbitrary = fc.record<StreamPlan>({
  kind: fc.constantFrom<SpecKind>('delta', 'reasoning', 'toolStatus', 'toolOutput'),
  activity: fc.nat({ max: 2 }),
  dropRoll: fc.nat({ max: 9 }),
  duplicateRoll: fc.nat({ max: 9 }),
  markerRoll: fc.nat({ max: 9 }),
  jitter: fc.nat({ max: 2 }),
  pauseRoll: fc.nat({ max: 9 }),
})

interface Fate {
  readonly drop: boolean
  readonly duplicate: boolean
  readonly marker: boolean
  readonly jitter: number
  readonly pause: boolean
}

interface Scenario {
  readonly published: Published[]
  readonly fates: Fate[]
  readonly terminal: Published
}

/**
 * Turns a generated plan into the stream the main process would actually have
 * published (contiguous sequences, a `tool.status` before the first output of
 * any activity) plus the fate the channel deals each event.
 *
 * The FIRST status of an activity is never dropped: the snapshot contract
 * carries tool OUTPUT but no activity identity, so losing the status that
 * created the activity is unrecoverable by design (see the dedicated test
 * below). Terminal events are never dropped either — the preload only ever
 * evicts delta/reasoning/tool events.
 */
function buildScenario(plans: readonly StreamPlan[], origin: TurnOrigin = ORIGIN): Scenario {
  const published: Published[] = []
  const fates: Fate[] = []
  const startedActivities = new Set<number>()
  let sequence = 0

  const push = (build: (sequence: number) => ProductEvent, fate: Fate) => {
    sequence += 1
    published.push({ sequence, event: build(sequence) })
    fates.push(fate)
  }

  plans.forEach((plan, index) => {
    const fate: Fate = {
      drop: plan.dropRoll >= 8,
      duplicate: plan.duplicateRoll >= 8,
      marker: plan.markerRoll >= 3,
      jitter: plan.jitter,
      pause: plan.pauseRoll >= 5,
    }
    const activityId = `activity-${plan.activity}`
    const text = `<${index}>`

    if (plan.kind === 'delta' || plan.kind === 'reasoning') {
      push(
        (value) => ({
          type: plan.kind === 'delta' ? 'transcript.delta' : 'transcript.reasoning',
          sessionId: SESSION,
          turnId: TURN,
          origin,
          sequence: value,
          text,
        }),
        fate,
      )
      return
    }

    const firstStatus = !startedActivities.has(plan.activity)
    if (plan.kind === 'toolStatus' || firstStatus) {
      startedActivities.add(plan.activity)
      push(
        (value) => ({
          type: 'tool.status',
          sessionId: SESSION,
          turnId: TURN,
          origin,
          sequence: value,
          activityId,
          name: activityId,
          state: 'running',
        }),
        firstStatus ? { ...fate, drop: false } : fate,
      )
      if (plan.kind === 'toolStatus') return
    }
    push(
      (value) => ({
        type: 'tool.output',
        sessionId: SESSION,
        turnId: TURN,
        origin,
        sequence: value,
        activityId,
        text,
        preliminary: false,
      }),
      fate,
    )
  })

  sequence += 1
  const terminal: Published = {
    sequence,
    event: {
      type: 'transcript.complete',
      sessionId: SESSION,
      turnId: TURN,
      origin,
      sequence,
    },
  }
  return { published, fates, terminal }
}

/** Delivery order after a bounded-window reorder. `Array#sort` is stable. */
function deliveryOrder(fates: readonly Fate[]): number[] {
  return fates
    .map((fate, index) => ({ index, key: index + fate.jitter }))
    .sort((left, right) => left.key - right.key)
    .map((entry) => entry.index)
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('event transport — sequence continuity under an adversarial channel', () => {
  it('reconstructs the ground-truth transcript exactly, however the channel misbehaves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(streamPlanArbitrary, { minLength: 1, maxLength: 14 }),
        async (plans) => {
          const { published, fates, terminal } = buildScenario(plans)
          const truth = accumulate([...published, terminal], terminal.sequence)

          // The snapshot command answers with the authoritative prefix AT
          // REQUEST TIME, so a re-sync that starts early recovers less than one
          // that starts late — exactly like the real main process.
          let publishedThrough = 0
          let fetches = 0
          const consumer = createConsumer(async () => {
            fetches += 1
            return snapshotAt([...published, terminal], publishedThrough)
          })

          consumer.handleProductEvent({
            type: 'conversation.started',
            sessionId: SESSION,
            turnId: TURN,
            origin: ORIGIN,
            consumedAttachmentIds: [],
          })
          expect(consumer.store.getState().turn.phase).toBe('active')

          const prefixHolds = () => {
            const { answer, reasoning } = consumer.store.getState()
            expect(truth.answer.startsWith(answer)).toBe(true)
            expect(truth.reasoning.startsWith(reasoning)).toBe(true)
          }

          let lostAnything = false
          let markers = 0
          for (const index of deliveryOrder(fates)) {
            const entry = published[index]
            const fate = fates[index]
            publishedThrough = Math.max(publishedThrough, entry.sequence)
            if (fate.drop) {
              lostAnything = true
              // An eviction leaves a marker; a transport-level drop does not.
              if (fate.marker) {
                markers += 1
                consumer.handleProductEvent(gapMarker(publishedThrough))
              }
            } else {
              consumer.handleProductEvent(entry.event)
              if (fate.duplicate) consumer.handleProductEvent(entry.event)
            }
            prefixHolds()
            if (fate.pause) {
              await tick()
              prefixHolds()
            }
          }

          publishedThrough = terminal.sequence
          consumer.handleProductEvent(terminal.event)
          for (let attempt = 0; attempt < 24 && !consumer.terminalSettled; attempt += 1) {
            await tick()
          }
          for (let attempt = 0; attempt < 24 && consumer.sync.pending(TURN); attempt += 1) {
            await tick()
          }

          // 1. The terminal event is delayed by a re-sync but never lost.
          expect(consumer.terminalSettled).toBe(true)
          // 2. The reconstructed transcript is EXACTLY the ground truth.
          const final = consumer.store.getState()
          expect(final.answer).toBe(truth.answer)
          expect(final.reasoning).toBe(truth.reasoning)
          for (const { activityId, text } of truth.toolOutputs) {
            const activity = final.activities.find((item) => item.activityId === activityId)
            expect(activity?.output).toBe(text)
          }
          // 3. A loss is never silently absorbed.
          if (lostAnything) expect(fetches).toBeGreaterThan(0)
          // 4. Re-syncs stay bounded: no snapshot storm.
          expect(fetches).toBeLessThanOrEqual(2 * (published.length + markers) + 4)
          expect(consumer.errors).toEqual([])
        },
      ),
      { numRuns: 150 },
    )
  })

  it('never re-syncs when the channel delivers the stream intact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          streamPlanArbitrary.map((plan) => ({
            ...plan,
            dropRoll: 0,
            markerRoll: 0,
            jitter: 0,
          })),
          { minLength: 1, maxLength: 12 },
        ),
        async (plans) => {
          const { published, fates, terminal } = buildScenario(plans)
          const truth = accumulate([...published, terminal], terminal.sequence)
          let fetches = 0
          const consumer = createConsumer(async () => {
            fetches += 1
            return snapshotAt([...published, terminal], terminal.sequence)
          })

          consumer.handleProductEvent({
            type: 'conversation.started',
            sessionId: SESSION,
            turnId: TURN,
            origin: ORIGIN,
            consumedAttachmentIds: [],
          })
          for (const index of deliveryOrder(fates)) {
            const { event } = published[index]
            consumer.handleProductEvent(event)
            // A replayed buffer entry must not double the text.
            if (fates[index].duplicate) consumer.handleProductEvent(event)
          }
          consumer.handleProductEvent(terminal.event)
          await tick()

          expect(fetches).toBe(0)
          expect(consumer.store.getState().answer).toBe(truth.answer)
          expect(consumer.store.getState().reasoning).toBe(truth.reasoning)
        },
      ),
      { numRuns: 80 },
    )
  })
})

// ---------------------------------------------------------------------------
// The History view is the second consumer of the same protocol. It renders no
// activity feed, so the interesting question is whether the events it does not
// render still keep its watermark aligned. This mirrors the switch in
// `homepage/hooks/useConversationEventBridge.ts`.
// ---------------------------------------------------------------------------

function createHistoryConsumer(
  fetchSnapshot: (turnId: string) => Promise<TranscriptSnapshot | null>,
) {
  const store = createConversationStore({ transport: { stopTurn: async () => true } })
  const state = () => store.getState()
  const sync = createTranscriptSync({
    fetchSnapshot,
    applySnapshot: (snapshot) => {
      const turn = state().turn
      if (turn.phase !== 'active' || turn.scope.turnId !== snapshot.turnId) return
      state().replaceTranscript({ answer: snapshot.answer, reasoning: snapshot.reasoning })
    },
    onError: (message) => state().reportError(message),
  })

  const handleProductEvent = (event: ProductEvent): void => {
    if ('origin' in event && event.origin !== 'homepage') return
    switch (event.type) {
      case 'tool.status':
      case 'tool.output': {
        const { accepted } = state().dispatch({
          type: 'streamEvent',
          sessionId: event.sessionId,
          turnId: event.turnId,
        })
        if (!accepted) return
        sync.gate(event)
        return
      }
      case 'transcript.reasoning':
      case 'transcript.delta': {
        const { accepted } = state().dispatch({
          type: 'streamEvent',
          sessionId: event.sessionId,
          turnId: event.turnId,
        })
        if (!accepted) return
        if (!sync.gate(event)) return
        state().appendTranscript(
          event.type === 'transcript.delta' ? { answer: event.text } : { reasoning: event.text },
        )
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
    }
  }

  return { store, handleProductEvent }
}

describe('event transport — the History consumer of the same protocol', () => {
  it('never re-syncs over events it does not render', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          streamPlanArbitrary.map((plan) => ({
            ...plan,
            dropRoll: 0,
            markerRoll: 0,
            jitter: 0,
            duplicateRoll: 0,
          })),
          { minLength: 1, maxLength: 12 },
        ),
        async (plans) => {
          const { published, terminal } = buildScenario(plans, 'homepage')
          const truth = accumulate([...published, terminal], terminal.sequence)
          let fetches = 0
          const consumer = createHistoryConsumer(async () => {
            fetches += 1
            return snapshotAt([...published, terminal], terminal.sequence, 'homepage')
          })
          consumer.store.getState().dispatch({ type: 'initiate', kind: 'chat', sessionId: SESSION })
          consumer.store
            .getState()
            .dispatch({ type: 'commandSettled', sessionId: SESSION, turnId: TURN })
          expect(consumer.store.getState().turn.phase).toBe('active')

          // The History window only ever sees turns whose origin is its own.
          for (const { event } of published) consumer.handleProductEvent(event)
          consumer.handleProductEvent(terminal.event)
          await tick()

          // A tool call is not a hole: the activity events consume sequences the
          // History view does not render, and tracking them is what keeps this
          // consumer from fetching a snapshot per tool call.
          expect(fetches).toBe(0)
          expect(consumer.store.getState().answer).toBe(truth.answer)
          expect(consumer.store.getState().reasoning).toBe(truth.reasoning)
        },
      ),
      { numRuns: 80 },
    )
  })
})

describe('event transport — per-turn watermark isolation', () => {
  it('keeps up to MAX_TRACKED_TURNS interleaved turns independent without a re-sync', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 60 }),
        async (turnPicks) => {
          let fetches = 0
          const sync = createTranscriptSync({
            fetchSnapshot: async () => {
              fetches += 1
              return snapshotAt([], 0)
            },
            applySnapshot: () => undefined,
          })
          const next = new Map<number, number>()
          for (const pick of turnPicks) {
            const sequence = (next.get(pick) ?? 0) + 1
            next.set(pick, sequence)
            expect(sync.gate({ turnId: `turn-${pick}`, sequence })).toBe(true)
          }
          await tick()
          expect(fetches).toBe(0)
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('event transport — documented recovery limits', () => {
  it('cannot restore a tool activity whose creating status event was evicted', async () => {
    // The snapshot contract carries tool OUTPUT keyed by activityId but no
    // activity identity (name/state), so a re-sync cannot recreate the activity
    // row. The output is retained (buffered against the id) and the transcript
    // stays exact — only the activity feed entry is permanently missing.
    const published: Published[] = [
      {
        sequence: 1,
        event: {
          type: 'tool.status',
          sessionId: SESSION,
          turnId: TURN,
          origin: ORIGIN,
          sequence: 1,
          activityId: 'activity-0',
          name: 'shell',
          state: 'running',
        },
      },
      {
        sequence: 2,
        event: {
          type: 'tool.output',
          sessionId: SESSION,
          turnId: TURN,
          origin: ORIGIN,
          sequence: 2,
          activityId: 'activity-0',
          text: 'output',
          preliminary: false,
        },
      },
    ]
    const consumer = createConsumer(async () => snapshotAt(published, 2))
    consumer.handleProductEvent({
      type: 'conversation.started',
      sessionId: SESSION,
      turnId: TURN,
      origin: ORIGIN,
      consumedAttachmentIds: [],
    })
    // The status event is evicted; only the marker and the output arrive.
    consumer.handleProductEvent(gapMarker(1))
    consumer.handleProductEvent(published[1].event)
    await tick()

    expect(consumer.snapshotsApplied).toBeGreaterThanOrEqual(1)
    expect(consumer.store.getState().activities).toEqual([])
  })
})
