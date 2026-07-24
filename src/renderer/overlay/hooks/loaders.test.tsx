// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const listModels = vi.fn(async () => [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, isDefault: true },
])
const getSettings = vi.fn(async () => ({
  appearance: { answerHeight: 600 },
  assistant: { model: 'gpt-x' },
  shortcuts: undefined,
}))

vi.mock('../../desktop', () => ({
  desktopClient: {
    available: true,
    listModels: () => listModels(),
    getSettings: () => getSettings(),
  },
}))

import { useOverlayModels } from './useOverlayModels'
import { useOverlaySettings } from './useOverlaySettings'

afterEach(() => {
  vi.clearAllMocks()
})

// Regression: the load effects must run EXACTLY once on mount, even though the
// caller (Overlay.tsx) passes fresh inline callbacks on every render. A naive
// `[onModels, ...]` dependency array re-fires the load on every re-render — and
// because a resolved load updates the store (a new models array), that render
// cascades into an infinite settings.get / models.list request loop.
describe('overlay loader hooks fire once despite unstable callbacks', () => {
  it('useOverlayModels loads once across re-renders', async () => {
    const { rerender } = renderHook(() =>
      // New callback identities every render on purpose.
      useOverlayModels({ onModels: () => {}, onModelId: () => {}, onError: () => {} }),
    )
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1))
    rerender()
    rerender()
    rerender()
    await Promise.resolve()
    expect(listModels).toHaveBeenCalledTimes(1)
  })

  it('useOverlaySettings loads once across re-renders', async () => {
    const { rerender } = renderHook(() =>
      useOverlaySettings({
        onAnswerHeight: () => {},
        onShortcuts: () => {},
        onModelId: () => {},
        onError: () => {},
      }),
    )
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1))
    rerender()
    rerender()
    rerender()
    await Promise.resolve()
    expect(getSettings).toHaveBeenCalledTimes(1)
  })
})
