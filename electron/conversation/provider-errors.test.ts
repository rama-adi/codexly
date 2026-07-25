import { describe, expect, it } from 'vitest'

import {
  ProviderTimeoutError,
  toTaggedProviderError,
} from './provider-errors'

describe('toTaggedProviderError', () => {
  it.each([
    ["Thread 'thr-stale' not found after server restart", 'StaleThreadError'],
    [
      'JSON-RPC error -32600: no rollout found for thread id thr-rollout',
      'StaleThreadError',
    ],
    [
      "reasoning.effort 'minimal' cannot be used with the web_search tool",
      'MinimalEffortUnsupportedError',
    ],
    [
      'the selected tools cannot be used with reasoning.effort of minimal',
      'MinimalEffortUnsupportedError',
    ],
    ['ECONNRESET while reading the app-server stream', 'ProviderRequestError'],
  ])('maps %j to %s at the single sniffing boundary', (message, tag) => {
    const tagged = toTaggedProviderError(new Error(message))
    expect(tagged._tag).toBe(tag)
    expect(tagged.message).toBe(message)
    expect(tagged.cause).toBeInstanceOf(Error)
  })

  it('passes an already-tagged provider error straight through', () => {
    const timeout = new ProviderTimeoutError('no output')
    expect(toTaggedProviderError(timeout)).toBe(timeout)
  })

  it('tags non-error throws so downstream logic never sees a raw value', () => {
    const tagged = toTaggedProviderError('provider exploded')
    expect(tagged._tag).toBe('ProviderRequestError')
    expect(tagged.message).toBe('provider exploded')
  })
})
