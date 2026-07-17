import { describe, expect, it } from 'vitest'

import { SubscriptionEventEnvelopeSchema } from './events'

const windowChangedEvent = {
  version: 1,
  eventId: 'event-7',
  subscriptionId: 'subscription-1',
  sequence: 7,
  emittedAt: '2026-07-18T12:00:00.000Z',
  event: {
    type: 'window.changed',
    window: {
      version: 1,
      role: 'toolbar',
      displayId: 'display-1',
      bounds: { x: 100, y: 80, width: 720, height: 96 },
      visible: true,
      focused: false,
      minimized: false,
      maximized: false,
      fullScreen: false,
      alwaysOnTop: true,
      updatedAt: '2026-07-18T12:00:00.000Z',
    },
  },
} as const

describe('subscription event parsing', () => {
  it('parses a typed event envelope', () => {
    expect(SubscriptionEventEnvelopeSchema.parse(windowChangedEvent)).toEqual(windowChangedEvent)
  })

  it('rejects unknown event types and payload mismatches', () => {
    expect(
      SubscriptionEventEnvelopeSchema.safeParse({
        ...windowChangedEvent,
        event: { type: 'shell.command', command: 'rm -rf' },
      }).success,
    ).toBe(false)

    expect(
      SubscriptionEventEnvelopeSchema.safeParse({
        ...windowChangedEvent,
        event: {
          type: 'window.changed',
          window: { ...windowChangedEvent.event.window, role: 'settings' },
        },
      }).success,
    ).toBe(false)
  })

  it('rejects invalid sequencing and unversioned payloads', () => {
    expect(
      SubscriptionEventEnvelopeSchema.safeParse({ ...windowChangedEvent, sequence: -1 }).success,
    ).toBe(false)

    expect(
      SubscriptionEventEnvelopeSchema.safeParse({
        ...windowChangedEvent,
        event: {
          ...windowChangedEvent.event,
          window: { ...windowChangedEvent.event.window, version: 2 },
        },
      }).success,
    ).toBe(false)
  })
})
