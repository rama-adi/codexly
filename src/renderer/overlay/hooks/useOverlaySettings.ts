import { useEffect, useRef } from 'react'

import { DEFAULT_SHORTCUTS, type Shortcuts } from '../../../shared/schemas/settings'
import { desktopClient } from '../../desktop'
import type { ModelChoice } from '../types'

const FALLBACK_MODELS: ModelChoice[] = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4' },
]

type UseOverlaySettingsOptions = {
  onAnswerHeight: (height: number) => void
  onShortcuts: (shortcuts: Shortcuts) => void
  onModelId: (updater: (current: string) => string) => void
  onError: (error: unknown, fallback: string) => void
}

// Load the canonical settings once on mount and seed appearance/shortcuts.
// Callbacks are read through a ref so the load effect runs exactly once and
// never re-fires when the caller passes fresh inline callbacks each render.
export function useOverlaySettings(options: UseOverlaySettingsOptions): void {
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient
      .getSettings()
      .then((settings) => {
        latest.current.onAnswerHeight(settings.appearance.answerHeight)
        latest.current.onShortcuts(settings.shortcuts ?? DEFAULT_SHORTCUTS)
        latest.current.onModelId((current) =>
          current === FALLBACK_MODELS[0].id ? settings.assistant.model : current,
        )
      })
      .catch((error) => latest.current.onError(error, 'Could not load overlay settings.'))
  }, [])
}
