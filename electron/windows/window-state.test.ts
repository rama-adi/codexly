import { describe, expect, it } from 'vitest'

import { transitionOverlayState } from './window-state'

describe('transitionOverlayState', () => {
  it('moves from hidden through showing to an idle visible state', () => {
    const showing = transitionOverlayState(
      'hidden',
      { type: 'show-requested' },
      false,
    )

    expect(showing).toBe('showing')
    expect(transitionOverlayState(showing, { type: 'shown' }, false)).toBe(
      'visible-idle',
    )
  })

  it('selects the streaming visible state when a shown event arrives', () => {
    expect(transitionOverlayState('showing', { type: 'shown' }, true)).toBe(
      'visible-streaming',
    )
  })

  it('serializes hide events into the hidden state', () => {
    const hiding = transitionOverlayState(
      'visible-streaming',
      { type: 'hide-requested' },
      true,
    )

    expect(hiding).toBe('hiding')
    expect(transitionOverlayState(hiding, { type: 'hidden' }, true)).toBe(
      'hidden',
    )
  })

  it('suspends and resumes capture using actual visibility', () => {
    const suspended = transitionOverlayState(
      'visible-idle',
      { type: 'capture-suspended' },
      false,
    )

    expect(suspended).toBe('capture-suspended')
    expect(
      transitionOverlayState(
        suspended,
        { type: 'capture-resumed', visible: true },
        true,
      ),
    ).toBe('visible-streaming')
    expect(
      transitionOverlayState(
        suspended,
        { type: 'capture-resumed', visible: false },
        false,
      ),
    ).toBe('hidden')
  })

  it('keeps redundant and post-destruction transitions idempotent', () => {
    expect(
      transitionOverlayState('hidden', { type: 'hide-requested' }, false),
    ).toBe('hidden')
    expect(
      transitionOverlayState('destroyed', { type: 'show-requested' }, false),
    ).toBe('destroyed')
  })
})
