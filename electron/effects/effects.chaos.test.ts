import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { retry, RetryAbortedError } from './retry'
import { createScope } from './scope'
import { taggedError } from './tagged-error'
import { withTimeout } from './with-timeout'

/**
 * Chaos / property suite for the effect utilities the main-process turn
 * lifecycle is built on. Each of them has exactly one contract that the
 * lifecycle relies on, and each is checked here under randomised interleavings
 * rather than hand-picked cases:
 *
 *   - `Scope`   — every finalizer runs exactly once, in reverse registration
 *                 order, even when finalizers throw and closes overlap.
 *   - `retry`   — the attempt budget and `shouldRetry` are respected exactly.
 *   - `withTimeout` — the race never settles twice and always clears its timer.
 *
 * Only fake timers are used, advanced explicitly, so every run is deterministic
 * for its seed.
 */

class TransientError extends taggedError('TransientError') {}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

type ScopeOp =
  | { type: 'defer'; async: boolean; throws: boolean }
  | { type: 'close'; awaited: boolean }
  | { type: 'flush' }

const scopeOpArb: fc.Arbitrary<ScopeOp> = fc.oneof(
  {
    arbitrary: fc
      .tuple(fc.boolean(), fc.boolean())
      .map(([async, throws]): ScopeOp => ({ type: 'defer', async, throws })),
    weight: 5,
  },
  {
    arbitrary: fc.boolean().map((awaited): ScopeOp => ({ type: 'close', awaited })),
    weight: 2,
  },
  { arbitrary: fc.constant<ScopeOp>({ type: 'flush' }), weight: 1 },
)

interface ScopeRun {
  /** Ids in the order the finalizers actually ran. */
  readonly order: number[]
  readonly runs: Map<number, number>
  readonly errors: unknown[]
  readonly registered: Array<{ id: number; beforeFirstClose: boolean; throws: boolean }>
}

async function runScopeOps(ops: readonly ScopeOp[]): Promise<ScopeRun> {
  const order: number[] = []
  const runs = new Map<number, number>()
  const errors: unknown[] = []
  const registered: ScopeRun['registered'] = []
  const scope = createScope({
    label: 'chaos',
    onFinalizerError: (error) => errors.push(error),
  })
  const unawaited: Array<Promise<void>> = []
  let nextId = 0
  let closeCount = 0

  for (const op of ops) {
    if (op.type === 'defer') {
      const id = nextId
      nextId += 1
      // `closed` flips synchronously inside close(), so this is exactly the
      // "registered after teardown began" distinction the contract makes.
      registered.push({ id, beforeFirstClose: !scope.closed, throws: op.throws })
      scope.defer(async () => {
        runs.set(id, (runs.get(id) ?? 0) + 1)
        order.push(id)
        if (op.async) await Promise.resolve()
        if (op.throws) throw new TransientError(`finalizer ${id} failed`)
      })
      continue
    }
    if (op.type === 'close') {
      closeCount += 1
      const closing = scope.close(`close-${closeCount}`)
      if (op.awaited) await closing
      else unawaited.push(closing)
      continue
    }
    await Promise.resolve()
  }

  // `close` must never reject, so this doubles as a rejection check.
  await scope.close('final')
  await Promise.all(unawaited)
  // A finalizer registered after close runs on a microtask; give them room.
  for (let round = 0; round < 8; round += 1) await Promise.resolve()

  return { order, runs, errors, registered }
}

describe('effects chaos — Scope', () => {
  it('runs every finalizer exactly once in reverse order under overlapping closes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(scopeOpArb, { minLength: 1, maxLength: 24 }),
        async (ops) => {
          const { order, runs, errors, registered } = await runScopeOps(ops)

          // Exactly once — no double-clean, no leak.
          for (const entry of registered) {
            expect(runs.get(entry.id), `finalizer ${entry.id} run count`).toBe(1)
          }
          expect(order.length).toBe(registered.length)

          // Reverse registration order for the batch that existed when teardown
          // began. Late finalizers run on their own microtasks and can interleave,
          // so they are excluded from the ordering claim (their exactly-once
          // guarantee is checked above).
          const batch = registered.filter((entry) => entry.beforeFirstClose).map((entry) => entry.id)
          const observed = order.filter((id) => batch.includes(id))
          expect(observed).toEqual([...batch].reverse())

          // Throw tolerance: every failure is reported, and none of them stopped
          // the teardown (which the exactly-once check above already proved).
          expect(errors.length).toBe(registered.filter((entry) => entry.throws).length)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('never runs a finalizer twice no matter how many closes race', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 6 }),
        async (finalizerCount, closeCount) => {
          const runs: number[] = []
          const scope = createScope({ label: 'race', onFinalizerError: () => undefined })
          for (let index = 0; index < finalizerCount; index += 1) {
            scope.defer(async () => {
              await Promise.resolve()
              runs.push(index)
            })
          }
          await Promise.all(
            Array.from({ length: closeCount }, (_value, index) => scope.close(`close-${index}`)),
          )
          expect(runs).toEqual(
            Array.from({ length: finalizerCount }, (_value, index) => finalizerCount - 1 - index),
          )
          expect(scope.closed).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

interface RetryModel {
  calls: number
  outcome: 'success' | 'failure' | 'exhausted'
}

/** The contract, restated independently of the implementation. */
function modelRetry(
  attempts: number,
  fails: readonly boolean[],
  retryable: readonly boolean[],
): RetryModel {
  const budget = Math.max(0, Math.trunc(attempts))
  if (budget === 0) return { calls: 0, outcome: 'exhausted' }
  let calls = 0
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    calls += 1
    if (!fails[(attempt - 1) % fails.length]) return { calls, outcome: 'success' }
    if (!(attempt < budget && retryable[(attempt - 1) % retryable.length])) {
      return { calls, outcome: 'failure' }
    }
  }
  return { calls, outcome: 'failure' }
}

describe('effects chaos — retry', () => {
  const attemptsArb = fc.oneof(
    fc.integer({ min: -2, max: 6 }),
    // Fractional budgets must truncate rather than produce a half attempt.
    fc.constantFrom(2.9, 0.4),
  )
  const flagsArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 6 })

  it('respects the attempt budget and shouldRetry exactly', async () => {
    await fc.assert(
      fc.asyncProperty(attemptsArb, flagsArb, flagsArb, async (attempts, fails, retryable) => {
        const model = modelRetry(attempts, fails, retryable)
        const seen: number[] = []
        const outcome = await retry(
          {
            attempts,
            delayMs: 0,
            shouldRetry: (_error, attempt) => retryable[(attempt - 1) % retryable.length],
          },
          async (attempt) => {
            seen.push(attempt)
            if (fails[(attempt - 1) % fails.length]) throw new TransientError(`attempt ${attempt}`)
            return attempt
          },
        ).then(
          (value) => ({ kind: 'success' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        )

        expect(seen.length).toBe(model.calls)
        // Attempt numbers are 1-based and contiguous.
        expect(seen).toEqual(seen.map((_value, index) => index + 1))

        if (model.outcome === 'success') {
          expect(outcome.kind).toBe('success')
        } else {
          expect(outcome.kind).toBe('error')
          expect(outcome.kind === 'error' && (outcome.error as { _tag?: string })._tag).toBe(
            model.outcome === 'exhausted' ? 'RetryExhaustedError' : 'TransientError',
          )
        }
      }),
      { numRuns: 400 },
    )
  })

  it('computes the backoff from the attempt that just failed, once per retry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (attempts) => {
        const delayAttempts: number[] = []
        await expect(
          retry(
            {
              attempts,
              delayMs: (attempt) => {
                delayAttempts.push(attempt)
                return 0
              },
            },
            async () => {
              throw new TransientError()
            },
          ),
        ).rejects.toBeInstanceOf(TransientError)
        // One delay between attempts, never after the last one.
        expect(delayAttempts).toEqual(
          Array.from({ length: attempts - 1 }, (_value, index) => index + 1),
        )
      }),
      { numRuns: 100 },
    )
  })

  it('stops at the attempt the signal aborts on, whichever attempt that is', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 1, max: 5 }),
        async (attempts, abortAtRaw) => {
          const abortAt = ((abortAtRaw - 1) % (attempts - 1)) + 1
          const controller = new AbortController()
          const seen: number[] = []
          await expect(
            retry(
              {
                attempts,
                delayMs: 0,
                signal: controller.signal,
                shouldRetry: (_error, attempt) => {
                  if (attempt === abortAt) controller.abort(new RetryAbortedError('cancelled'))
                  return true
                },
              },
              async (attempt) => {
                seen.push(attempt)
                throw new TransientError()
              },
            ),
          ).rejects.toMatchObject({ _tag: 'RetryAbortedError', message: 'cancelled' })
          expect(seen.length).toBe(abortAt)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

type TimeoutStep = { type: 'advance'; ms: number } | { type: 'resolve' } | { type: 'reject' }

const timeoutStepArb: fc.Arbitrary<TimeoutStep> = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 40 }).map((ms): TimeoutStep => ({ type: 'advance', ms })), weight: 3 },
  { arbitrary: fc.constant<TimeoutStep>({ type: 'resolve' }), weight: 2 },
  { arbitrary: fc.constant<TimeoutStep>({ type: 'reject' }), weight: 1 },
)

describe('effects chaos — withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never settles twice and always clears its timer, whatever wins the race', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 60 }),
        fc.array(timeoutStepArb, { minLength: 1, maxLength: 8 }),
        async (timeoutMs, steps) => {
          vi.useFakeTimers()
          const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
          const onTimeout = vi.fn(() => 'fallback')
          let resolveOperation: (value: string) => void = () => undefined
          let rejectOperation: (error: unknown) => void = () => undefined
          const operation = new Promise<string>((resolve, reject) => {
            resolveOperation = resolve
            rejectOperation = reject
          })
          operation.catch(() => undefined)

          const raced = withTimeout(operation, timeoutMs, onTimeout)
          const observed: Array<{ kind: 'value' | 'error'; detail: string }> = []
          void raced.then(
            (value) => observed.push({ kind: 'value', detail: value }),
            (error: unknown) => observed.push({ kind: 'error', detail: (error as Error).message }),
          )

          let advanced = 0
          let operationSettled = false
          let operationSettledBeforeTimer = false
          for (const step of steps) {
            if (step.type === 'advance') {
              advanced += step.ms
              await vi.advanceTimersByTimeAsync(step.ms)
              continue
            }
            if (!operationSettled) {
              operationSettled = true
              operationSettledBeforeTimer = advanced < timeoutMs
            }
            if (step.type === 'resolve') resolveOperation('done')
            else rejectOperation(new Error('operation failed'))
            await Promise.resolve()
          }

          // Force a settle so the assertions describe a finished race.
          resolveOperation('done')
          await vi.advanceTimersByTimeAsync(timeoutMs + 1)
          await raced.catch(() => undefined)
          await Promise.resolve()

          // A promise settles once by construction; what could double-settle is
          // the timer branch firing after the operation already won.
          expect(observed.length, 'settled more than once').toBe(1)
          expect(onTimeout.mock.calls.length, 'onTimeout fired more than once').toBeLessThanOrEqual(1)
          // The timer is always cleared, so a decided race leaves no handle.
          expect(clearSpy).toHaveBeenCalled()

          if (operationSettledBeforeTimer) {
            // The operation won: its own outcome is reported and the timeout
            // handler is never consulted.
            expect(onTimeout).not.toHaveBeenCalled()
            expect(observed[0].detail).not.toBe('fallback')
          }
          if (!onTimeout.mock.calls.length) {
            expect(observed[0].detail).not.toBe('fallback')
          }

          // Nothing fires after the race is decided.
          const callsAfterSettle = onTimeout.mock.calls.length
          await vi.advanceTimersByTimeAsync(10_000)
          expect(onTimeout.mock.calls.length).toBe(callsAfterSettle)

          clearSpy.mockRestore()
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reports the same outcome for the same schedule every time', async () => {
    const run = async (timeoutMs: number, steps: readonly TimeoutStep[]): Promise<string> => {
      vi.useFakeTimers()
      let resolveOperation: (value: string) => void = () => undefined
      const operation = new Promise<string>((resolve) => {
        resolveOperation = resolve
      })
      const raced = withTimeout(operation, timeoutMs, () => 'fallback')
      for (const step of steps) {
        if (step.type === 'advance') await vi.advanceTimersByTimeAsync(step.ms)
        else resolveOperation('done')
        await Promise.resolve()
      }
      resolveOperation('done')
      await vi.advanceTimersByTimeAsync(timeoutMs + 1)
      const outcome = await raced
      vi.useRealTimers()
      return outcome
    }

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 60 }),
        fc.array(
          fc.oneof(
            fc.integer({ min: 0, max: 40 }).map((ms): TimeoutStep => ({ type: 'advance', ms })),
            fc.constant<TimeoutStep>({ type: 'resolve' }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        async (timeoutMs, steps) => {
          expect(await run(timeoutMs, steps)).toBe(await run(timeoutMs, steps))
        },
      ),
      { numRuns: 120 },
    )
  })
})
