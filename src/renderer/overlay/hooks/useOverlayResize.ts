import { useEffect, type RefObject } from 'react'

import { desktopClient } from '../../desktop'

// The window is a frame around the HUD, and the HUD's own scroll containers cap
// how large that content can get (`appearance.answerHeight`, at most 1400px, plus
// the panel chrome around it). These bounds only have to stay clear of that cap:
// a window smaller than its content would have nowhere to put the overflow — the
// overlay document cannot scroll (see overlay.css) — so the tail would be lost.
const MAX_WIDTH = 900
const MAX_HEIGHT = 1600
const MIN_WIDTH = 360
const MIN_HEIGHT = 48

// Observe the overlay root and keep the desktop window sized to its content.
export function useOverlayResize(rootRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!rootRef.current || !desktopClient.available) return
    const element = rootRef.current
    let frame: number | undefined
    let lastWidth = 0
    let lastHeight = 0
    const resize = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!rootRef.current) return
        const width = Math.ceil(
          Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, rootRef.current.scrollWidth)),
        )
        const height = Math.ceil(
          Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, rootRef.current.scrollHeight)),
        )
        if (width === lastWidth && height === lastHeight) return
        lastWidth = width
        lastHeight = height
        void desktopClient.resizeOverlay(width, height).catch(() => undefined)
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [rootRef])
}
