import { describe, expect, it } from 'vitest'

import {
  acceleratorTokens,
  eventToAccelerator,
  formatAccelerator,
  type KeyEventLike,
} from './accelerator'

function key(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    code: '',
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }
}

describe('eventToAccelerator', () => {
  it('builds a Cmd/Ctrl + Shift + letter accelerator in Electron order', () => {
    expect(
      eventToAccelerator(key({ code: 'KeyB', metaKey: true, shiftKey: true })).accelerator,
    ).toBe('CommandOrControl+Shift+B')
  })

  it('maps physical keys to Electron tokens', () => {
    expect(eventToAccelerator(key({ code: 'Space', metaKey: true })).accelerator).toBe(
      'CommandOrControl+Space',
    )
    expect(eventToAccelerator(key({ code: 'Enter', ctrlKey: true, shiftKey: true })).accelerator).toBe(
      'CommandOrControl+Shift+Enter',
    )
    expect(eventToAccelerator(key({ code: 'Digit1', metaKey: true })).accelerator).toBe(
      'CommandOrControl+1',
    )
    expect(eventToAccelerator(key({ code: 'ArrowUp', altKey: true })).accelerator).toBe('Alt+Up')
  })

  it('waits while only modifiers are held', () => {
    const result = eventToAccelerator(key({ code: 'MetaLeft', metaKey: true }))
    expect(result.accelerator).toBeNull()
    expect(result.reason).toBe('incomplete')
  })

  it('rejects a bare key with no primary modifier', () => {
    const result = eventToAccelerator(key({ code: 'KeyA' }))
    expect(result.accelerator).toBeNull()
    expect(result.reason).toBe('needs-modifier')
  })

  it('allows a function key to stand alone', () => {
    expect(eventToAccelerator(key({ code: 'F5' })).accelerator).toBe('F5')
  })
})

describe('formatAccelerator', () => {
  it('renders macOS symbols with no separator', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'darwin')).toBe('⌘⇧Space')
    expect(formatAccelerator('CommandOrControl+Shift+Enter', 'darwin')).toBe('⌘⇧⏎')
  })

  it('renders other platforms with named modifiers joined by +', () => {
    expect(formatAccelerator('CommandOrControl+Shift+B', 'other')).toBe('Ctrl+Shift+B')
  })

  it('exposes individual tokens for chip rendering', () => {
    expect(acceleratorTokens('CommandOrControl+Shift+1', 'darwin')).toEqual(['⌘', '⇧', '1'])
  })
})
