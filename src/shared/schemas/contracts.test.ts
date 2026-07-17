import { describe, expect, it } from 'vitest'

import { SerializedErrorSchema } from '../errors'
import { CapabilitiesSchema } from './capabilities'
import { JsonValueSchema } from './common'
import { CanonicalSettingsSchema } from './settings'

const settings = {
  version: 1,
  appearance: { theme: 'system', reducedMotion: false },
  application: { launchAtLogin: false, showDockIcon: true, startMinimized: false },
  privacy: { persistConversations: true, shareDiagnostics: false },
  capture: {
    includeMicrophone: false,
    includeSystemAudio: true,
    screenshotFormat: 'png',
  },
  assistant: {
    model: 'codex-default',
    reasoningEffort: 'medium',
    responseLanguage: 'en-US',
  },
} as const

describe('shared schemas', () => {
  it('accepts canonical settings and rejects unknown nested fields', () => {
    expect(CanonicalSettingsSchema.parse(settings)).toEqual(settings)

    expect(
      CanonicalSettingsSchema.safeParse({
        ...settings,
        privacy: { ...settings.privacy, telemetryToken: 'secret' },
      }).success,
    ).toBe(false)
  })

  it('allows explicit JSON extensions while rejecting non-serializable values', () => {
    expect(
      CanonicalSettingsSchema.safeParse({
        ...settings,
        extensions: { experimental: { enabled: true, rollout: 0.25 } },
      }).success,
    ).toBe(true)

    expect(JsonValueSchema.safeParse({ createdAt: new Date() }).success).toBe(false)
    expect(JsonValueSchema.safeParse({ handler: () => undefined }).success).toBe(false)
    expect(JsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
  })

  it('rejects duplicate capabilities', () => {
    const capability = { name: 'screenshots', available: true } as const
    const result = CapabilitiesSchema.safeParse({
      version: 1,
      platform: 'darwin',
      evaluatedAt: '2026-07-18T12:00:00.000Z',
      items: [capability, capability],
    })

    expect(result.success).toBe(false)
  })

  it('keeps serialized errors strict and safe for transport', () => {
    const error = {
      version: 1,
      code: 'unavailable',
      message: 'Microphone permission is unavailable',
      retryable: true,
      details: { capability: 'microphone' },
    } as const

    expect(SerializedErrorSchema.parse(error)).toEqual(error)
    expect(SerializedErrorSchema.safeParse({ ...error, stack: 'private stack' }).success).toBe(
      false,
    )
    expect(
      SerializedErrorSchema.safeParse({ ...error, details: { timestamp: new Date() } }).success,
    ).toBe(false)
  })
})
