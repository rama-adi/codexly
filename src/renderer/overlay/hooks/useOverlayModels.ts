import { useEffect, useRef } from 'react'

import { desktopClient } from '../../desktop'
import type { ModelChoice } from '../types'

type UseOverlayModelsOptions = {
  onModels: (models: ModelChoice[]) => void
  onModelId: (updater: (current: string) => string) => void
  onError: (error: unknown, fallback: string) => void
}

// Load the visible models once on mount and reconcile the selected model id.
// Callbacks are read through a ref so the load effect can run exactly once and
// never re-fire when the caller passes fresh inline callbacks each render.
export function useOverlayModels(options: UseOverlayModelsOptions): void {
  const latest = useRef(options)
  // Refreshed after commit, never during render. Declared before the load
  // effect so the first assignment lands before that effect reads it.
  useEffect(() => {
    latest.current = options
  })

  useEffect(() => {
    if (!desktopClient.available) return
    void desktopClient
      .listModels()
      .then((list) => {
        const visible = list.filter((model) => !model.hidden)
        if (!visible.length) return
        latest.current.onModels(
          visible.map((model) => ({ id: model.id, displayName: model.displayName })),
        )
        latest.current.onModelId((current) => {
          if (visible.some((model) => model.id === current)) return current
          return visible.find((model) => model.isDefault)?.id ?? visible[0].id
        })
      })
      .catch((error) => latest.current.onError(error, 'Could not load available models.'))
  }, [])
}
