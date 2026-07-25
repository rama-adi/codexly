import { describe, expect, it } from 'vitest'

import { errorTag, isTagged, taggedError } from './tagged-error'

class ProviderTimeoutError extends taggedError('ProviderTimeoutError') {}
class StaleThreadError extends taggedError('StaleThreadError') {}

describe('taggedError', () => {
  it('produces real errors that carry a literal tag and preserve the cause', () => {
    const cause = new Error('socket closed')
    const error = new ProviderTimeoutError('no first token', { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('ProviderTimeoutError')
    expect(error.name).toBe('ProviderTimeoutError')
    expect(error.message).toBe('no first token')
    expect(error.cause).toBe(cause)
    expect(ProviderTimeoutError.tag).toBe('ProviderTimeoutError')
  })

  it('falls back to the tag as the message so a bare throw is still legible', () => {
    expect(new StaleThreadError().message).toBe('StaleThreadError')
  })

  it('discriminates between sibling tags for exhaustive matching', () => {
    const errors: Array<ProviderTimeoutError | StaleThreadError> = [
      new ProviderTimeoutError(),
      new StaleThreadError(),
    ]
    expect(errors.map((error) => error._tag)).toEqual([
      'ProviderTimeoutError',
      'StaleThreadError',
    ])
    expect(isTagged(errors[0], 'ProviderTimeoutError')).toBe(true)
    expect(isTagged(errors[0], 'StaleThreadError')).toBe(false)
  })

  it('never claims a tag for plain errors or non-error values', () => {
    expect(isTagged(new Error('boom'), 'ProviderTimeoutError')).toBe(false)
    expect(isTagged({ _tag: 'ProviderTimeoutError' }, 'ProviderTimeoutError')).toBe(false)
    expect(isTagged(null, 'ProviderTimeoutError')).toBe(false)
    expect(errorTag(new Error('boom'))).toBeNull()
    expect(errorTag('boom')).toBeNull()
    expect(errorTag(new StaleThreadError())).toBe('StaleThreadError')
  })
})
