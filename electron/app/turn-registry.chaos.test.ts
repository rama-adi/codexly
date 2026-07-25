import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { TurnOrigin } from '../../src/shared/ipc/product'
import {
  TurnLifecycleHarness,
  type LifecycleAction,
  type TerminalEventType,
} from './turn-lifecycle-harness'
import { mergePendingAttachmentIds } from './turn-registry'

/**
 * Chaos / property suite for the main-process turn lifecycle.
 *
 * `TurnLifecycleHarness` replays the exact steps `ProductController` performs
 * around `TurnRegistry`, with every await point behind a manually resolved
 * deferred. A generated action list therefore pins the whole interleaving:
 * runtime startup can resolve before or after a stop, a terminal event can land
 * before the announcement, a session can be deleted mid-startup, and the same
 * seed always replays the same schedule. No timers are involved.
 *
 * The invariants are checked continuously (after every action) and again once
 * the harness has settled every outstanding deferred, so a violation reported by
 * the shrinker is a minimal action list rather than a timing accident.
 */

const SESSION_IDS = ['session-a', 'session-b'] as const
const ORIGINS: readonly TurnOrigin[] = ['overlay', 'homepage']
const TERMINAL_EVENTS: readonly TerminalEventType[] = [
  'turn.completed',
  'turn.interrupted',
  'turn.failed',
]

/** Reduced modulo the number of started turns, so it always names a real one. */
const turnSelector = fc.nat({ max: 5 })

const sendArb = fc
  .tuple(fc.constantFrom(...ORIGINS), fc.constantFrom(...SESSION_IDS), fc.boolean())
  .map(([origin, sessionId, persistConversation]): LifecycleAction => ({
    type: 'send',
    origin,
    sessionId,
    persistConversation,
  }))

type TurnScopedActionType = Extract<LifecycleAction, { turn: number }>['type']

const turnScoped = (type: Exclude<TurnScopedActionType, 'terminalEvent'>) =>
  turnSelector.map((turn): LifecycleAction => ({ type, turn }))

const terminalArb = fc
  .tuple(turnSelector, fc.constantFrom(...TERMINAL_EVENTS))
  .map(([turn, event]): LifecycleAction => ({ type: 'terminalEvent', turn, event }))

const actionArb: fc.Arbitrary<LifecycleAction> = fc.oneof(
  { arbitrary: sendArb, weight: 5 },
  { arbitrary: turnScoped('resolveStartup'), weight: 5 },
  { arbitrary: turnScoped('rejectStartup'), weight: 1 },
  { arbitrary: turnScoped('announce'), weight: 4 },
  { arbitrary: turnScoped('streamEvent'), weight: 5 },
  { arbitrary: turnScoped('toolOutput'), weight: 2 },
  { arbitrary: terminalArb, weight: 3 },
  { arbitrary: turnScoped('settleCompletion'), weight: 3 },
  { arbitrary: turnScoped('stop'), weight: 4 },
  {
    arbitrary: fc
      .boolean()
      .map((preserveSession): LifecycleAction => ({ type: 'openOverlay', preserveSession })),
    weight: 3,
  },
  { arbitrary: fc.constant<LifecycleAction>({ type: 'clearAttachments' }), weight: 2 },
  { arbitrary: fc.constant<LifecycleAction>({ type: 'resetSession' }), weight: 2 },
  {
    arbitrary: fc
      .constantFrom(...SESSION_IDS)
      .map((sessionId): LifecycleAction => ({ type: 'deleteSession', sessionId })),
    weight: 2,
  },
  { arbitrary: fc.constant<LifecycleAction>({ type: 'dispose' }), weight: 1 },
  { arbitrary: fc.constant<LifecycleAction>({ type: 'flush' }), weight: 1 },
)

const actionsArb = fc.array(actionArb, { minLength: 1, maxLength: 36 })

/** Renders a failing list compactly enough to paste back into a regression test. */
function describeActions(actions: readonly LifecycleAction[]): string {
  return actions
    .map((action) =>
      'turn' in action
        ? `${action.type}(#${action.turn}${action.type === 'terminalEvent' ? `,${action.event}` : ''})`
        : action.type === 'send'
          ? `send(${action.origin},${action.sessionId})`
          : action.type === 'openOverlay'
            ? `openOverlay(${action.preserveSession ? 'preserve' : 'fresh'})`
            : action.type === 'deleteSession'
              ? `deleteSession(${action.sessionId})`
              : action.type,
    )
    .join(' -> ')
}

/** Asserts everything that must hold once every outstanding deferred settled. */
function expectQuiescedInvariants(
  harness: TurnLifecycleHarness,
  actions: readonly LifecycleAction[],
): void {
  const trace = describeActions(actions)

  // Invariants 1 and 4 plus the exactly-once step check are accumulated by the
  // harness after every action.
  expect(harness.violations, trace).toEqual([])

  for (const slot of harness.slots) {
    // Invariant 2: every record reaches terminal and its finalizers run once.
    expect(slot.finalizerRuns, `${slot.turnId} finalizer runs | ${trace}`).toBe(1)
    expect(slot.record.state, `${slot.turnId} final state | ${trace}`).toBe('terminal')

    // Invariant 3: an abort requested before the handle attached is never lost —
    // it reaches the runtime immediately through the fallback, and fires again on
    // the handle the moment one attaches. Two cases have no handle to fire on and
    // are exempt: a startup that rejected (nothing was ever started, and the
    // catch path closed the record) and a record torn down before the handle
    // arrived (already terminal, so there is nothing left to stop).
    if (slot.abortOwedOnAttach !== null) {
      expect(slot.fallbackAborts.length, `${slot.turnId} fallback abort | ${trace}`).toBeGreaterThan(0)
      if (slot.startupOutcome === 'resolved' && !slot.closedBeforeAttach) {
        expect(slot.handleAborts.length, `${slot.turnId} handle abort | ${trace}`).toBeGreaterThan(0)
      }
    }

    // Sequence numbers a renderer observes are contiguous from 1, so a gap can
    // only ever mean the transport dropped something.
    const sequences = harness.sequencesFor(slot.turnId)
    expect(sequences, `${slot.turnId} sequences | ${trace}`).toEqual(
      sequences.map((_value, index) => index + 1),
    )
  }

  // Invariant 5: nothing is left in the registry.
  expect(harness.registry.size, `registry size | ${trace}`).toBe(0)
  expect(harness.registry.snapshots(), `registry snapshots | ${trace}`).toEqual([])

  // Every enqueued envelope is accounted for: published, deliberately dropped,
  // or discarded with the record that was torn down under it.
  const publishedTurnScoped = harness.published.filter((event) => event.sequence > 0).length
  const discarded = harness.slots.reduce((total, slot) => total + slot.discardedDeferred, 0)
  expect(
    publishedTurnScoped + harness.dropped.length + discarded,
    `event accounting | ${trace}`,
  ).toBe(harness.enqueuedEvents)

  // The overlay streaming affordance always lands off once nothing is live.
  if (harness.overlayStreaming.length > 0) {
    expect(harness.overlayStreaming.at(-1), `overlay streaming | ${trace}`).toBe(false)
  }

  // The retained transcripts are bounded and never claim to be live.
  expect(harness.retained.size, `retained size | ${trace}`).toBeLessThanOrEqual(8)
  for (const snapshot of harness.retained.values()) {
    expect(snapshot.live, `retained ${snapshot.turnId} live | ${trace}`).toBe(false)
  }
}

beforeAll(() => {
  // The registry logs a line per abort and per dropped event; a chaos run would
  // otherwise emit tens of thousands of them.
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('turn lifecycle chaos', () => {
  it('holds every lifecycle invariant across random interleavings', async () => {
    await fc.assert(
      fc.asyncProperty(actionsArb, async (actions) => {
        const harness = new TurnLifecycleHarness()
        await harness.run(actions)
        await harness.settle()
        expectQuiescedInvariants(harness, actions)
      }),
      { numRuns: 500 },
    )
  })

  it('holds them when the runtime cannot be reached and the overlay refuses to update', async () => {
    await fc.assert(
      fc.asyncProperty(actionsArb, fc.boolean(), async (actions, fallbackAbortSucceeds) => {
        const harness = new TurnLifecycleHarness({
          fallbackAbortSucceeds,
          overlayStreamingFails: true,
        })
        await harness.run(actions)
        await harness.settle()
        expectQuiescedInvariants(harness, actions)
      }),
      { numRuns: 300 },
    )
  })
})

describe('turn lifecycle chaos — generator reach', () => {
  /**
   * Guards against a vacuous suite: if the generator stopped producing the
   * interesting interleavings the invariant properties above would still pass
   * while proving nothing. Every counter here is a state the invariants are
   * about, so this test fails loudly if the action pool or weights drift.
   */
  it('reaches every state the invariants are about', async () => {
    const reach = {
      abortBeforeHandle: 0,
      abortReplayedOnHandle: 0,
      rejectedStartup: 0,
      deferredThenDrained: 0,
      discardedDeferred: 0,
      droppedWithoutRecord: 0,
      freshOverlayClear: 0,
      completionBeforeTerminal: 0,
      concurrentTurns: 0,
      disposeDuringLiveTurn: 0,
    }
    for (const actions of fc.sample(actionsArb, { numRuns: 400, seed: 1 })) {
      const harness = new TurnLifecycleHarness()
      let peak = 0
      for (const action of actions) {
        const liveBeforeDispose = action.type === 'dispose' ? harness.registry.size : 0
        await harness.apply(action)
        if (liveBeforeDispose > 0) reach.disposeDuringLiveTurn += 1
        peak = Math.max(peak, harness.registry.size)
        if (harness.registry.snapshots().some((row) => row.completionSettled && row.state !== 'terminal')) {
          reach.completionBeforeTerminal += 1
        }
      }
      if (peak > 1) reach.concurrentTurns += 1
      reach.freshOverlayClear += harness.clearActiveCount
      for (const slot of harness.slots) {
        if (slot.abortOwedOnAttach !== null) reach.abortBeforeHandle += 1
        if (slot.abortOwedOnAttach !== null && slot.handleAborts.length > 0) {
          reach.abortReplayedOnHandle += 1
        }
        if (slot.startupOutcome === 'rejected') reach.rejectedStartup += 1
        if (slot.discardedDeferred > 0) reach.discardedDeferred += 1
      }
      reach.deferredThenDrained += harness.drainedDeferredCount
      reach.droppedWithoutRecord += harness.dropped.filter((row) => row.reason === 'no-record').length
      // A record becomes terminal and leaves the registry in the same finalizer,
      // so a lookup can never return a terminal record: the 'terminal' branch of
      // decideTurnEventDisposition is purely defensive. If this ever starts
      // firing, teardown stopped being atomic and events can be seen mid-close.
      expect(harness.dropped.filter((row) => row.reason === 'terminal-record')).toEqual([])
      await harness.settle()
    }
    for (const [state, hits] of Object.entries(reach)) {
      expect(hits, `generator never reached: ${state}`).toBeGreaterThan(0)
    }
  })
})

describe('turn lifecycle chaos — session teardown', () => {
  /**
   * Narrow pool: sends interleaved only with the destructive operations and the
   * startup resolution. Shrinking on this pool yields a readable minimal case for
   * the "a session was cleared under a live turn" failure mode.
   */
  const teardownActionArb: fc.Arbitrary<LifecycleAction> = fc.oneof(
    { arbitrary: sendArb, weight: 4 },
    { arbitrary: turnScoped('resolveStartup'), weight: 3 },
    { arbitrary: turnScoped('announce'), weight: 2 },
    { arbitrary: turnScoped('settleCompletion'), weight: 2 },
    { arbitrary: terminalArb, weight: 2 },
    {
      arbitrary: fc
        .boolean()
        .map((preserveSession): LifecycleAction => ({ type: 'openOverlay', preserveSession })),
      weight: 4,
    },
    {
      arbitrary: fc
        .constantFrom(...SESSION_IDS)
        .map((sessionId): LifecycleAction => ({ type: 'deleteSession', sessionId })),
      weight: 4,
    },
    { arbitrary: fc.constant<LifecycleAction>({ type: 'clearAttachments' }), weight: 3 },
    { arbitrary: fc.constant<LifecycleAction>({ type: 'resetSession' }), weight: 3 },
  )

  it('never clears or deletes a session under a turn it has not finished or aborted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(teardownActionArb, { minLength: 1, maxLength: 24 }),
        async (actions) => {
          const harness = new TurnLifecycleHarness()
          await harness.run(actions)
          expect(harness.violations, describeActions(actions)).toEqual([])
          await harness.settle()
          expectQuiescedInvariants(harness, actions)
        },
      ),
      { numRuns: 400 },
    )
  })
})

describe('turn lifecycle chaos — stop during initiating', () => {
  /**
   * Every operation that can abort a turn, applied only while runtime startup is
   * still in flight. Whatever the interleaving, the stop must reach the handle
   * the moment startup resolves.
   */
  const preStartupAbortArb = fc.constantFrom<LifecycleAction>(
    { type: 'stop', turn: 0 },
    { type: 'clearAttachments' },
    { type: 'resetSession' },
    { type: 'deleteSession', sessionId: SESSION_IDS[0] },
    { type: 'flush' },
  )

  it('never loses a stop issued before the abort handle attaches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(preStartupAbortArb, { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        async (aborts, fallbackAbortSucceeds) => {
          const harness = new TurnLifecycleHarness({ fallbackAbortSucceeds })
          const actions: LifecycleAction[] = [
            { type: 'send', origin: 'overlay', sessionId: SESSION_IDS[0], persistConversation: true },
            ...aborts,
            { type: 'resolveStartup', turn: 0 },
          ]
          await harness.run(actions)
          const slot = harness.slots[0]
          const trace = describeActions(actions)

          const requestedAnAbort = aborts.some((action) => action.type !== 'flush')
          expect(slot.abortOwedOnAttach !== null, trace).toBe(requestedAnAbort)
          if (requestedAnAbort) {
            // Every pre-handle request reached the runtime immediately, and the
            // last one fired again on the handle as soon as it attached.
            expect(slot.fallbackAborts.length, trace).toBeGreaterThan(0)
            expect(slot.handleAborts, trace).toContain(slot.abortOwedOnAttach)
            // Exactly one replay: the pending reason is consumed, not re-fired.
            expect(slot.handleAborts.length, trace).toBe(1)
          } else {
            expect(slot.handleAborts, trace).toEqual([])
          }

          await harness.settle()
          expectQuiescedInvariants(harness, actions)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('mergePendingAttachmentIds', () => {
  const ATTACHMENT_IDS: readonly string[] = ['shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5']
  const idArb = fc.constantFrom(...ATTACHMENT_IDS)
  const idsArb = fc.uniqueArray(idArb, { maxLength: 5 })

  it('never drops a capture that completed while the listing was in flight', async () => {
    await fc.assert(
      fc.property(
        idsArb,
        fc.uniqueArray(idArb, { maxLength: 3 }),
        idsArb,
        (before, arrivals, listed) => {
          // `arrivals` are captures that completed during the await; the queue the
          // merge sees is the pre-listing queue plus those.
          const after = [...before, ...arrivals.filter((id) => !before.includes(id))]
          const merged = mergePendingAttachmentIds(before, after, listed)
          for (const id of arrivals) {
            if (before.includes(id)) continue
            expect(merged).toContain(id)
          }
          // Nothing invented, nothing duplicated, and the listing order is kept.
          expect(new Set(merged).size).toBe(merged.length)
          expect(merged.filter((id) => listed.includes(id))).toEqual(listed)
          for (const id of merged) {
            expect(listed.includes(id) || after.includes(id)).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('drops exactly the ids the listing no longer reports and nothing arrived for', async () => {
    await fc.assert(
      fc.property(idsArb, idsArb, (before, listed) => {
        // No concurrent capture: the merge must equal the listing verbatim.
        expect(mergePendingAttachmentIds(before, [...before], listed)).toEqual(listed)
      }),
      { numRuns: 200 },
    )
  })

  it('is idempotent when replayed against its own result', async () => {
    await fc.assert(
      fc.property(idsArb, idsArb, idsArb, (before, after, listed) => {
        const once = mergePendingAttachmentIds(before, after, listed)
        expect(mergePendingAttachmentIds(before, once, listed)).toEqual(once)
      }),
      { numRuns: 200 },
    )
  })
})
