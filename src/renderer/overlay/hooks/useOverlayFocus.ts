import { useEffect, useRef, type RefObject } from 'react'

import { desktopClient } from '../../desktop'
import type { View } from '../types'

type UseOverlayFocusOptions = {
  view: View
  inputRef: RefObject<HTMLInputElement>
  onError: (error: unknown, fallback: string) => void
}

// The overlay is created non-focusable so clicking its controls never pulls
// key focus away from the app the user is working in. Only the chat view
// needs the keyboard, so make the window focusable while it is open — and
// release focus back to the user's app when leaving it. The effect keys on
// `view` alone; the ref/callback are read through a ref so an unstable caller
// cannot cause the focus toggle to re-fire every render.
export function useOverlayFocus({ view, inputRef, onError }: UseOverlayFocusOptions): void {
  const latest = useRef({ inputRef, onError })
  latest.current = { inputRef, onError }

  useEffect(() => {
    if (!desktopClient.available) return
    const focusable = view === 'chat'
    let cancelled = false
    void desktopClient
      .setOverlayFocusable(focusable)
      .then(() => {
        if (!cancelled && focusable) latest.current.inputRef.current?.focus()
      })
      .catch((error) => latest.current.onError(error, 'Could not adjust overlay focus.'))
    return () => {
      cancelled = true
    }
  }, [view])
}
