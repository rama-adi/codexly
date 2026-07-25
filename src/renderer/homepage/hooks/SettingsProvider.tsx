import type { ReactNode } from 'react'

import { SettingsContext, useSettingsSource } from './useSettings'

/**
 * Holds the homepage window's ONE settings subscription. Every page reads it via
 * `useSettings`, so mounting a second consumer no longer opens a second
 * `settings.changed` listener with its own divergent copy.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const value = useSettingsSource()
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
