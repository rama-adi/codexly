import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import type { CanonicalSettings } from '../../../shared/schemas/settings'
import { desktopClient } from '../../desktop'

/** Recursive partial patch applied section-by-section over canonical settings. */
export type SettingsPatch = {
  [K in keyof CanonicalSettings]?: Partial<CanonicalSettings[K]>
}

function mergeSettings(
  base: CanonicalSettings,
  patch: SettingsPatch,
): CanonicalSettings {
  const next = { ...base } as CanonicalSettings
  for (const key of Object.keys(patch) as Array<keyof CanonicalSettings>) {
    const section = patch[key]
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      next[key] = { ...(base[key] as object), ...(section as object) } as never
    } else if (section !== undefined) {
      next[key] = section as never
    }
  }
  return next
}

export interface UseSettingsResult {
  settings: CanonicalSettings | null
  loading: boolean
  saving: boolean
  error: string | null
  /** Reads current settings, applies the patch, and persists the full object. */
  update: (patch: SettingsPatch) => Promise<CanonicalSettings | null>
}

/**
 * The window's single settings subscription. Mounted exactly once, by
 * `SettingsProvider`; every consumer reads it through {@link useSettings} so a
 * window never holds two independent copies of the canonical settings.
 */
export function useSettingsSource(): UseSettingsResult {
  const [settings, setSettings] = useState<CanonicalSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<CanonicalSettings | null>(null)

  const apply = useCallback((next: CanonicalSettings) => {
    latest.current = next
    setSettings(next)
  }, [])

  useEffect(() => {
    if (!desktopClient.available) {
      setLoading(false)
      return
    }
    let active = true
    desktopClient
      .getSettings()
      .then((next) => {
        if (active) apply(next)
      })
      .catch((cause) => {
        if (active) setError(errorText(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    const unsubscribe = desktopClient.onProductEvent((event) => {
      if (event.type === 'settings.changed') apply(event.settings)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [apply])

  const update = useCallback(
    async (patch: SettingsPatch) => {
      const base = latest.current
      if (!base || !desktopClient.available) return null
      const optimistic = mergeSettings(base, patch)
      apply(optimistic)
      setSaving(true)
      setError(null)
      try {
        const persisted = await desktopClient.updateSettings(optimistic)
        apply(persisted)
        return persisted
      } catch (cause) {
        apply(base)
        setError(errorText(cause))
        return null
      } finally {
        setSaving(false)
      }
    },
    [apply],
  )

  return { settings, loading, saving, error, update }
}

export const SettingsContext = createContext<UseSettingsResult | null>(null)

export function useSettings(): UseSettingsResult {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings requires a <SettingsProvider> ancestor.')
  return value
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The operation failed.'
}
