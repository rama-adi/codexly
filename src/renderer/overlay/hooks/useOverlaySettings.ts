import { useEffect } from 'react'

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
export function useOverlaySettings({
  onAnswerHeight,
  onShortcuts,
  onModelId,
  onError,
}: UseOverlaySettingsOptions): void {
  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient
      .getSettings()
      .then((settings) => {
        onAnswerHeight(settings.appearance.answerHeight)
        onShortcuts(settings.shortcuts ?? DEFAULT_SHORTCUTS)
        onModelId((current) =>
          current === FALLBACK_MODELS[0].id ? settings.assistant.model : current,
        )
      })
      .catch((error) => onError(error, 'Could not load overlay settings.'))
  }, [onAnswerHeight, onShortcuts, onModelId, onError])
}
