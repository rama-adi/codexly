import { describe, expect, it, vi } from 'vitest'

import { retry, RetryAbortedError } from './retry'
import { taggedError } from './tagged-error'

class TransientError extends taggedError('TransientError') {}
class FatalError extends taggedError('FatalError') {}

describe('retry', () => {
  it('returns the first success without delaying', async () => {
    const delayMs = vi.fn(() => 1_000)
    const fn = vi.fn(async () => 'ok')
    await expect(retry({ attempts: 3, delayMs }, fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
    expect(delayMs).not.toHaveBeenCalled()
  })

  it('retries up to the attempt budget and reports the attempt number', async () => {
    const attempts: number[] = []
    const result = await retry({ attempts: 3, delayMs: 0 }, async (attempt) => {
      attempts.push(attempt)
      if (attempt < 3) throw new TransientError()
      return attempt
    })
    expect(result).toBe(3)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('rethrows the last error once the budget is exhausted', async () => {
    const fn = vi.fn(async () => {
      throw new TransientError('warm failed')
    })
    await expect(retry({ attempts: 2, delayMs: 0 }, fn)).rejects.toMatchObject({
      _tag: 'TransientError',
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('stops immediately when shouldRetry declines the error', async () => {
    const fn = vi.fn(async () => {
      throw new FatalError()
    })
    await expect(
      retry(
        {
          attempts: 5,
          delayMs: 0,
          shouldRetry: (error) => (error as { _tag?: string })._tag === 'TransientError',
        },
        fn,
      ),
    ).rejects.toMatchObject({ _tag: 'FatalError' })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('computes a per-attempt backoff from the failed attempt number', async () => {
    const delays: number[] = []
    const delayMs = (attempt: number) => {
      delays.push(attempt)
      return 0
    }
    await expect(retry({ attempts: 3, delayMs }, async () => {
      throw new TransientError()
    })).rejects.toBeInstanceOf(TransientError)
    expect(delays).toEqual([1, 2])
  })

  it('does not run anything when the signal is already aborted', async () => {
    const fn = vi.fn(async () => 'ok')
    const controller = new AbortController()
    controller.abort(new RetryAbortedError('shutting down'))
    await expect(retry({ attempts: 3, delayMs: 0, signal: controller.signal }, fn)).rejects.toMatchObject(
      { _tag: 'RetryAbortedError', message: 'shutting down' },
    )
    expect(fn).not.toHaveBeenCalled()
  })

  it('interrupts a pending delay as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const fn = vi.fn(async () => {
      throw new TransientError()
    })
    const pending = retry(
      { attempts: 5, delayMs: 10_000, signal: controller.signal },
      fn,
    )
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(new RetryAbortedError('workspace changed'))
    await expect(pending).rejects.toMatchObject({
      _tag: 'RetryAbortedError',
      message: 'workspace changed',
    })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('passes a plain abort reason through instead of wrapping it', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      retry({ attempts: 3, delayMs: 0, signal: controller.signal }, async () => 'ok'),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('surfaces an exhausted policy when it allows no attempts at all', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(retry({ attempts: 0, delayMs: 0 }, fn)).rejects.toMatchObject({
      _tag: 'RetryExhaustedError',
    })
    expect(fn).not.toHaveBeenCalled()
  })
})
