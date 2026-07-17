import { describe, expect, it } from 'vitest'

import { createCapabilities } from './capabilities'

describe('createCapabilities', () => {
  it('returns every contract capability exactly once', () => {
    const capabilities = createCapabilities(
      { codex: { available: true } },
      { platform: 'darwin', evaluatedAt: '2026-01-01T00:00:00.000Z' },
    )

    expect(capabilities.version).toBe(1)
    expect(capabilities.platform).toBe('darwin')
    expect(capabilities.items).toHaveLength(9)
    expect(new Set(capabilities.items.map((item) => item.name)).size).toBe(9)
    expect(capabilities.items.find((item) => item.name === 'codex')).toEqual({
      name: 'codex',
      available: true,
    })
  })

  it('preserves unavailable reasons and normalizes unsupported platforms to linux', () => {
    const capabilities = createCapabilities(
      {
        screenshots: {
          available: false,
          reason: 'denied',
          detail: 'Screen Recording permission is denied.',
        },
      },
      { platform: 'freebsd' },
    )

    expect(capabilities.platform).toBe('linux')
    expect(capabilities.items.find((item) => item.name === 'screenshots')).toEqual({
      name: 'screenshots',
      available: false,
      reason: 'denied',
      detail: 'Screen Recording permission is denied.',
    })
  })
})
