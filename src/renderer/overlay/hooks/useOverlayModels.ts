import { useEffect } from 'react'

import { desktopClient } from '../../desktop'
import type { ModelChoice } from '../types'

type UseOverlayModelsOptions = {
  onModels: (models: ModelChoice[]) => void
  onModelId: (updater: (current: string) => string) => void
  onError: (error: unknown, fallback: string) => void
}

// Load the visible models once on mount and reconcile the selected model id.
export function useOverlayModels({ onModels, onModelId, onError }: UseOverlayModelsOptions): void {
  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient
      .listModels()
      .then((list) => {
        const visible = list.filter((model) => !model.hidden)
        if (!visible.length) return
        onModels(visible.map((model) => ({ id: model.id, displayName: model.displayName })))
        onModelId((current) => {
          if (visible.some((model) => model.id === current)) return current
          return visible.find((model) => model.isDefault)?.id ?? visible[0].id
        })
      })
      .catch((error) => onError(error, 'Could not load available models.'))
  }, [onModels, onModelId, onError])
}
