import { describe, expect, it } from 'vitest'

import { BootstrapRequestSchema, SubscribeResponseSchema } from './contracts'
import { RequestEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes'

const envelopeBase = {
  version: 1,
  requestId: 'request-1',
  sentAt: '2026-07-18T12:00:00.000Z',
} as const

describe('IPC envelopes', () => {
  it('parses a serializable request envelope', () => {
    const request = {
      ...envelopeBase,
      operation: 'settings.update',
      payload: { appearance: { theme: 'dark' } },
    } as const

    expect(RequestEnvelopeSchema.parse(request)).toEqual(request)
  })

  it('rejects malformed and non-serializable requests', () => {
    expect(
      RequestEnvelopeSchema.safeParse({
        ...envelopeBase,
        operation: 'shell.execute',
        payload: {},
      }).success,
    ).toBe(false)

    expect(
      RequestEnvelopeSchema.safeParse({
        ...envelopeBase,
        operation: 'settings.get',
        payload: { callback: () => undefined },
      }).success,
    ).toBe(false)

    expect(
      BootstrapRequestSchema.safeParse({
        ...envelopeBase,
        operation: 'bootstrap.get',
        payload: { unexpected: true },
      }).success,
    ).toBe(false)
  })

  it('distinguishes success and failure response envelopes', () => {
    const success = {
      version: 1,
      requestId: 'request-1',
      operation: 'settings.get',
      receivedAt: '2026-07-18T12:00:00.100Z',
      ok: true,
      data: { theme: 'dark' },
    } as const
    const failure = {
      version: 1,
      requestId: 'request-2',
      operation: 'settings.get',
      receivedAt: '2026-07-18T12:00:00.100Z',
      ok: false,
      error: {
        version: 1,
        code: 'unauthorized',
        message: 'Sign in required',
        retryable: false,
      },
    } as const

    expect(ResponseEnvelopeSchema.parse(success)).toEqual(success)
    expect(ResponseEnvelopeSchema.parse(failure)).toEqual(failure)
    expect(ResponseEnvelopeSchema.safeParse({ ...success, error: failure.error }).success).toBe(
      false,
    )
    expect(ResponseEnvelopeSchema.safeParse({ ...failure, data: null }).success).toBe(false)
  })

  it('pins operations and payloads in typed response contracts', () => {
    const response = {
      version: 1,
      requestId: 'request-3',
      operation: 'subscriptions.subscribe',
      receivedAt: '2026-07-18T12:00:00.100Z',
      ok: true,
      data: { subscriptionId: 'subscription-1' },
    } as const

    expect(SubscribeResponseSchema.parse(response)).toEqual(response)
    expect(
      SubscribeResponseSchema.safeParse({ ...response, operation: 'settings.get' }).success,
    ).toBe(false)
    expect(
      SubscribeResponseSchema.safeParse({ ...response, data: { subscriptionId: '' } }).success,
    ).toBe(false)
  })
})
