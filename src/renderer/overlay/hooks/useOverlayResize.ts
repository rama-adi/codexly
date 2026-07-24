import { useEffect, type RefObject } from 'react'

import { desktopClient } from '../../desktop'

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
        const width = Math.ceil(Math.min(900, Math.max(360, rootRef.current.scrollWidth)))
        const height = Math.ceil(Math.min(1000, Math.max(48, rootRef.current.scrollHeight)))
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
