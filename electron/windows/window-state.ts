import type { Rectangle } from 'electron'

import type { WindowRole } from './window-options'

export const OVERLAY_STATES = [
  'hidden',
  'showing',
  'visible-idle',
  'visible-streaming',
  'capture-suspended',
  'hiding',
  'destroyed',
] as const

export type OverlayState = (typeof OVERLAY_STATES)[number]

export type OverlayTransition =
  | { type: 'show-requested' }
  | { type: 'shown' }
  | { type: 'hide-requested' }
  | { type: 'hidden' }
  | { type: 'stream-started' }
  | { type: 'stream-stopped' }
  | { type: 'capture-suspended' }
  | { type: 'capture-resumed'; visible: boolean }
  | { type: 'destroyed' }

export interface WindowSnapshot {
  role: WindowRole
  visible: boolean
  focused: boolean
  minimized: boolean
  maximized: boolean
  fullScreen: boolean
  destroyed: boolean
  bounds: Rectangle | null
  overlayState?: OverlayState
}

export function transitionOverlayState(
  state: OverlayState,
  transition: OverlayTransition,
  streaming: boolean,
): OverlayState {
  if (state === 'destroyed') {
    return state
  }

  switch (transition.type) {
    case 'show-requested':
      return state === 'hidden' || state === 'hiding' ? 'showing' : state
    case 'shown':
      return state === 'capture-suspended'
        ? state
        : streaming
          ? 'visible-streaming'
          : 'visible-idle'
    case 'hide-requested':
      return state === 'hidden' ? state : 'hiding'
    case 'hidden':
      return 'hidden'
    case 'stream-started':
      return state === 'visible-idle' ? 'visible-streaming' : state
    case 'stream-stopped':
      return state === 'visible-streaming' ? 'visible-idle' : state
    case 'capture-suspended':
      return state === 'showing' || state.startsWith('visible-')
        ? 'capture-suspended'
        : state
    case 'capture-resumed':
      if (state !== 'capture-suspended') {
        return state
      }

      if (!transition.visible) {
        return 'hidden'
      }

      return streaming ? 'visible-streaming' : 'visible-idle'
    case 'destroyed':
      return 'destroyed'
  }
}
