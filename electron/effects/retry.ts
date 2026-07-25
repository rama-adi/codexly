import { taggedError } from './tagged-error'

/** Thrown when an abort signal cancels a retry loop before or between attempts. */
export class RetryAbortedError extends taggedError('RetryAbortedError') {}
/** Thrown when the policy allows zero attempts, so `fn` never ran. */
export class RetryExhaustedError extends taggedError('RetryExhaustedError') {}

export interface RetryPolicy {
  /** Total attempts, including the first. */
  attempts: number
  /** Fixed delay, or a delay derived from the 1-based attempt that just failed. */
  delayMs: number | ((attempt: number) => number)
  /** Decides whether a failed attempt may be retried. Defaults to always. */
  shouldRetry?(error: unknown, attempt: number): boolean
  /** Cancels the loop before the next attempt and interrupts pending delays. */
  signal?: AbortSignal
}

/**
 * Runs `fn` until it resolves, the policy runs out of attempts, `shouldRetry`
 * declines the error, or the signal aborts. The last error is rethrown.
 */
export async function retry<T>(
  policy: RetryPolicy,
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  const attempts = Math.max(0, Math.trunc(policy.attempts))
  throwIfAborted(policy.signal)
  let lastError: unknown = new RetryExhaustedError(
    `Retry policy allowed ${attempts} attempts.`,
  )
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      const canRetry =
        attempt < attempts && (policy.shouldRetry?.(error, attempt) ?? true)
      if (!canRetry) break
      throwIfAborted(policy.signal)
      await sleep(resolveDelay(policy.delayMs, attempt), policy.signal)
    }
  }
  throwIfAborted(policy.signal)
  throw lastError
}

function resolveDelay(delayMs: RetryPolicy['delayMs'], attempt: number): number {
  const value = typeof delayMs === 'function' ? delayMs(attempt) : delayMs
  return Number.isFinite(value) && value > 0 ? value : 0
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error
    ? reason
    : new RetryAbortedError(reason === undefined ? undefined : String(reason))
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error instanceof Error ? error : new RetryAbortedError())
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
