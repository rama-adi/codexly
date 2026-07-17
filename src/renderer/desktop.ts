import type { SubscriptionTopic } from '../shared/ipc/events'
import type { Bootstrap } from '../shared/schemas/bootstrap'
import type { CapabilityName } from '../shared/schemas/capabilities'
import type {
  DesktopSubscriptionCleanup,
  DesktopSubscriptionListener,
} from '../types/desktop-bridge'
import { desktopClient } from './services/desktop-client'

export type RendererCapability = 'capture' | 'window-controls'

const capabilityNames: Record<RendererCapability, CapabilityName> = {
  capture: 'screenshots',
  'window-controls': 'windowControls',
}

let latestBootstrap: Bootstrap | null = null

export const desktop = {
  get available(): boolean {
    return desktopClient.available
  },
  get snapshot(): Bootstrap | null {
    return latestBootstrap
  },
  async bootstrap(): Promise<Bootstrap> {
    latestBootstrap = await desktopClient.bootstrap()
    return latestBootstrap
  },
  async refreshSnapshot(): Promise<Bootstrap> {
    latestBootstrap = await desktopClient.snapshot()
    return latestBootstrap
  },
  subscribe(
    topics: readonly SubscriptionTopic[],
    listener: DesktopSubscriptionListener,
  ): Promise<DesktopSubscriptionCleanup> {
    return desktopClient.subscribe(topics, listener)
  },
}

export const hasCapability = (capability: RendererCapability): boolean => {
  const name = capabilityNames[capability]
  return (
    latestBootstrap?.capabilities.items.some(
      (item) => item.name === name && item.available,
    ) ?? false
  )
}
