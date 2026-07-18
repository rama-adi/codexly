import { useEffect } from 'react'

import type { Theme } from '../../../shared/schemas/settings'

/**
 * Applies the persisted appearance settings to the document. 'system' follows
 * the OS colour scheme live; explicit values win. Effect-only, so it never runs
 * during SSR.
 */
export function useTheme(theme: Theme, reducedMotion: boolean): void {
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const resolve = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      root.classList.toggle('dark', dark)
    }

    resolve()
    if (theme === 'system') {
      media.addEventListener('change', resolve)
      return () => media.removeEventListener('change', resolve)
    }
    return undefined
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reducedMotion)
  }, [reducedMotion])
}
