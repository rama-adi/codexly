import { describe, expect, it, vi } from 'vitest'

import { taggedError } from './tagged-error'
import { withTimeout } from './with-timeout'

class TimedOutError extends taggedError('TimedOutError') {}

describe('withTimeout', () => {
  it('returns the operation result when it settles first', async () => {
    const onTimeout = vi.fn(() => 'fallback')
    await expect(withTimeout(Promise.resolve('done'), 50, onTimeout)).resolves.toBe('done')
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('resolves with the fallback when the timer wins', async () => {
    const result = await withTimeout(new Promise<string>(() => undefined), 1, () => 'fallback')
    expect(result).toBe('fallback')
  })

  it('rejects with a tagged error when the timeout handler throws', async () => {
    await expect(
      withTimeout(new Promise<void>(() => undefined), 1, () => {
        throw new TimedOutError('provider went quiet')
      }),
    ).rejects.toMatchObject({ _tag: 'TimedOutError', message: 'provider went quiet' })
  })

  it('propagates an operation rejection instead of masking it as a timeout', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('interrupt failed')), 50, () => undefined),
    ).rejects.toThrow('interrupt failed')
  })

  it('clears the timer so a settled race leaves no pending handle', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout(Promise.resolve(1), 1_000, () => 2)
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
