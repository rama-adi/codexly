import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../src/shared/ipc/operations'
import type { ProductEvent } from '../src/shared/ipc/product'

/**
 * Property/chaos suite for the preload hand-off buffer.
 *
 * One window mounts several independent product-event consumers that do not
 * subscribe in the same tick, so `preload.ts` buffers everything the main process
 * emits before the first listener attaches and replays it to every listener that
 * attaches inside the grace window. The buffer is bounded (count + bytes), and
 * whatever it throws away has to leave a `transcript.gap` watermark so the
 * renderer re-syncs instead of trusting a transcript with a hole in it.
 *
 * These tests generate random interleavings of emissions, subscriptions,
 * unsubscriptions and buffer pressure, then assert the transport contract:
 *   1. NO STARVATION — every subscriber observes every event emitted after it
 *      attached, plus an ordered prefix from the buffer, whatever the subscribe
 *      order is (a narrow consumer must not swallow the buffer).
 *   2. ORDER + NO INVENTION — what a subscriber observes is always an ordered
 *      subsequence of what the main process emitted, never duplicated.
 *   3. DETECTABLE LOSS — if anything was evicted, the buffer carries a
 *      `transcript.gap` marker for that turn with a non-zero watermark.
 *   4. CAPS — the retained count and the retained streaming bytes stay inside
 *      their limits.
 *   5. NO DELIVERY AFTER UNSUBSCRIBE.
 */

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  exposed: undefined as unknown,
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, value: unknown) => {
      electron.exposed = value
    }),
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      electron.handlers.set(channel, listener)
    }),
  },
}))

/** Mirrors the private limits in preload.ts. */
const MAX_PENDING_PRODUCT_EVENTS = 128
const MAX_PENDING_STREAM_BYTES = 256 * 1024

interface ProductBridge {
  onProductEvent(listener: (event: ProductEvent) => void): () => void
}

async function loadBridge(): Promise<ProductBridge> {
  vi.resetModules()
  electron.handlers.clear()
  electron.exposed = undefined
  electron.invoke.mockReset()
  await import('./preload')
  return (electron.exposed as { v1: ProductBridge }).v1
}

function emitProduct(event: ProductEvent): void {
  electron.handlers.get(IPC_CHANNELS.productEvent)?.({}, event)
}

// ---------------------------------------------------------------------------
// Tokens: every streaming payload carries a unique marker so an observed text
// can be decomposed back into the emissions it came from, even after the buffer
// has coalesced a run of adjacent chunks into one entry.
// ---------------------------------------------------------------------------

const TOKEN = /#(\d+);/g

function tokensOf(text: string): number[] {
  return [...text.matchAll(TOKEN)].map((match) => Number(match[1]))
}

/** A copy taken AT DELIVERY: a buffered entry is mutated in place when coalesced. */
interface Observed {
  readonly type: ProductEvent['type']
  readonly text: string
  readonly turnId?: string
  readonly evictedThrough?: number
  readonly droppedCount?: number
}

function observe(event: ProductEvent): Observed {
  return {
    type: event.type,
    text: 'text' in event && typeof event.text === 'string' ? event.text : '',
    ...('turnId' in event ? { turnId: event.turnId } : {}),
    ...(event.type === 'transcript.gap'
      ? { evictedThrough: event.evictedThrough, droppedCount: event.droppedCount }
      : {}),
  }
}

interface Subscriber {
  readonly attachedAfter: number
  /** How many emitting ops had run when this subscriber attached. */
  readonly epoch: number
  readonly seen: Observed[]
  readonly afterUnsubscribe: Observed[]
  active: boolean
  /** The op index at which this subscriber detached, if it did. */
  unsubscribedAt: number | null
  unsubscribe(index: number): void
}

/** True for the event types preload is allowed to evict under pressure. */
function isEvictable(type: ProductEvent['type']): boolean {
  return (
    type === 'transcript.delta' ||
    type === 'transcript.reasoning' ||
    type === 'tool.output' ||
    type === 'tool.status'
  )
}

/** An ordered-subsequence check: `part` appears inside `whole`, in order. */
function isSubsequence(part: readonly number[], whole: readonly number[]): boolean {
  let cursor = 0
  for (const value of part) {
    const found = whole.indexOf(value, cursor)
    if (found < 0) return false
    cursor = found + 1
  }
  return true
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Op =
  | {
      readonly kind: 'stream'
      readonly variant: 'delta' | 'reasoning' | 'toolOutput'
      readonly turn: number
      readonly repeat: number
      readonly padding: number
    }
  | { readonly kind: 'control'; readonly variant: 'cleared' | 'sessions' | 'capture' }
  | { readonly kind: 'attach' }
  | { readonly kind: 'detach'; readonly which: number }

const opArbitrary = fc.oneof(
  { arbitrary: fc.constant<Op>({ kind: 'attach' }), weight: 3 },
  {
    arbitrary: fc.record<Extract<Op, { kind: 'stream' }>>({
      kind: fc.constant('stream'),
      variant: fc.constantFrom('delta', 'reasoning', 'toolOutput'),
      turn: fc.nat({ max: 1 }),
      repeat: fc.integer({ min: 1, max: 40 }),
      // A padded chunk is ~40 KiB, so a handful of them cross the byte cap.
      padding: fc.constantFrom(0, 0, 0, 20_000),
    }),
    weight: 8,
  },
  {
    arbitrary: fc.record<Extract<Op, { kind: 'control' }>>({
      kind: fc.constant('control'),
      variant: fc.constantFrom('cleared', 'sessions', 'capture'),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record<Extract<Op, { kind: 'detach' }>>({
      kind: fc.constant('detach'),
      which: fc.nat({ max: 5 }),
    }),
    weight: 1,
  },
)

async function runScenario(ops: readonly Op[]): Promise<void> {
  const bridge = await loadBridge()
  const subscribers: Subscriber[] = []
  /** Every streaming token the main process emitted, in order. */
  const emitted: number[] = []
  /** Token → the number of ops that had run when it was emitted. */
  const emittedAt = new Map<number, number>()
  let token = 0
  /** Bumped by every op that emits, so subscribers that attach between two
   * emissions share an epoch and must observe exactly the same stream. */
  let emissions = 0

  const attach = (attachedAfter: number): Subscriber => {
    const subscriber: Subscriber = {
      attachedAfter,
      epoch: emissions,
      seen: [],
      afterUnsubscribe: [],
      active: true,
      unsubscribedAt: null,
      unsubscribe: () => undefined,
    }
    const stop = bridge.onProductEvent((event) => {
      const record = observe(event)
      if (subscriber.active) subscriber.seen.push(record)
      else subscriber.afterUnsubscribe.push(record)
    })
    subscriber.unsubscribe = (index: number) => {
      subscriber.active = false
      subscriber.unsubscribedAt = index
      stop()
    }
    subscribers.push(subscriber)
    return subscriber
  }

  ops.forEach((op, index) => {
    switch (op.kind) {
      case 'attach':
        attach(index)
        return
      case 'detach': {
        const active = subscribers.filter((subscriber) => subscriber.active)
        if (active.length) active[op.which % active.length].unsubscribe(index)
        return
      }
      case 'control':
        emissions += 1
        emitProduct(
          op.variant === 'cleared'
            ? { type: 'attachments.cleared' }
            : op.variant === 'sessions'
              ? { type: 'sessions.changed' }
              : { type: 'attachment.captured', attachment: { id: `shot-${index}` } },
        )
        return
      case 'stream':
        emissions += 1
        for (let repeat = 0; repeat < op.repeat; repeat += 1) {
          token += 1
          emitted.push(token)
          emittedAt.set(token, index)
          const text = `#${token};${'x'.repeat(op.padding)}`
          const turnId = `turn-${op.turn}`
          if (op.variant === 'toolOutput') {
            emitProduct({
              type: 'tool.output',
              sessionId: 'session-1',
              turnId,
              origin: 'overlay',
              sequence: token,
              activityId: `activity-${op.turn}`,
              text,
              preliminary: false,
            })
          } else {
            emitProduct({
              type: op.variant === 'delta' ? 'transcript.delta' : 'transcript.reasoning',
              sessionId: 'session-1',
              turnId,
              origin: 'overlay',
              sequence: token,
              text,
            })
          }
        }
    }
  })

  // The auditor attaches last, so what it observes IS the retained buffer.
  const auditor = attach(ops.length)

  for (const subscriber of subscribers) {
    const seenTokens = subscriber.seen.flatMap((record) => tokensOf(record.text))

    // 2. Order + no invention, and no double delivery.
    expect(isSubsequence(seenTokens, emitted)).toBe(true)
    expect(new Set(seenTokens).size).toBe(seenTokens.length)

    // 1. No starvation: everything emitted after this subscriber attached
    // reaches it, whatever order the siblings subscribed in.
    const live = emitted.filter((value) => {
      const at = emittedAt.get(value) ?? -1
      if (at <= subscriber.attachedAfter) return false
      return subscriber.unsubscribedAt === null || at < subscriber.unsubscribedAt
    })
    expect(seenTokens.filter((value) => live.includes(value))).toEqual(live)

    // 5. Nothing is delivered after unsubscribe.
    expect(subscriber.afterUnsubscribe).toEqual([])
  }

  // 1b. Subscribe ORDER is irrelevant: subscribers that attached between the
  // same two emissions observe exactly the same stream, so a narrow consumer
  // cannot swallow the hand-off buffer from its siblings.
  const undetached = subscribers.filter((subscriber) => subscriber.unsubscribedAt === null)
  for (const subscriber of undetached) {
    const peer = undetached.find((candidate) => candidate.epoch === subscriber.epoch)
    expect(subscriber.seen).toEqual(peer?.seen)
  }

  // 4. Caps.
  expect(auditor.seen.length).toBeLessThanOrEqual(MAX_PENDING_PRODUCT_EVENTS)
  const retainsEvictable = auditor.seen.some((record) => isEvictable(record.type))
  if (retainsEvictable) {
    // Text is a lower bound on preload's own size estimate, so the cap it
    // enforces has to hold for it too.
    const retainedTextBytes = auditor.seen.reduce(
      (total, record) => total + record.text.length * 2,
      0,
    )
    expect(retainedTextBytes).toBeLessThanOrEqual(MAX_PENDING_STREAM_BYTES)
  }

  // 3. Loss is always detectable: a turn that lost tokens carries a watermark.
  const bufferedTokens = new Set(auditor.seen.flatMap((record) => tokensOf(record.text)))
  const lostTurns = new Set(
    ops.flatMap((op, index) =>
      op.kind === 'stream' &&
      emitted.some(
        (value) => emittedAt.get(value) === index && !bufferedTokens.has(value),
      )
        ? [`turn-${op.turn}`]
        : [],
    ),
  )
  for (const turnId of lostTurns) {
    const marker = auditor.seen.find(
      (record) => record.type === 'transcript.gap' && record.turnId === turnId,
    )
    expect(marker).toBeDefined()
    expect(marker?.droppedCount ?? 0).toBeGreaterThan(0)
    expect(marker?.evictedThrough ?? 0).toBeGreaterThan(0)
  }
  // A marker is never invented for a turn that lost nothing.
  for (const record of auditor.seen) {
    if (record.type !== 'transcript.gap') continue
    expect(lostTurns.has(record.turnId ?? '')).toBe(true)
  }
}

beforeEach(() => {
  // Freeze the clock so the replay grace window never closes mid-scenario; its
  // expiry is pinned by the deterministic tests in preload.test.ts.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('preload hand-off buffer under random interleavings', () => {
  it('never starves a subscriber, reorders, duplicates, or loses an event silently', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArbitrary, { minLength: 1, maxLength: 24 }),
        async (ops) => {
          await runScenario(ops)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('holds the same contract when every subscriber attaches before any event', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          opArbitrary.filter((op) => op.kind !== 'attach' && op.kind !== 'detach'),
          { minLength: 1, maxLength: 16 },
        ),
        fc.integer({ min: 1, max: 4 }),
        async (ops, subscriberCount) => {
          await runScenario([
            ...Array.from<unknown, Op>({ length: subscriberCount }, () => ({ kind: 'attach' })),
            ...ops,
          ])
        },
      ),
      { numRuns: 80 },
    )
  })
})
