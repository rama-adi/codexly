import { SubscriptionEventSchema } from '../../shared/ipc/events'
import { BootstrapSchema } from '../../shared/schemas/bootstrap'
import type { CodexlyDesktopBridgeV1 } from '../../types/desktop-bridge'

export interface DesktopClient extends CodexlyDesktopBridgeV1 {
  readonly available: boolean
}

const getBridge = () =>
  typeof window === 'undefined' ? undefined : window.codexly?.v1

export const desktopClient: DesktopClient = {
  get available() {
    return getBridge() !== undefined
  },
  async bootstrap() {
    const bridge = requireBridge()
    return BootstrapSchema.parse(await bridge.bootstrap())
  },
  async snapshot() {
    const bridge = requireBridge()
    return BootstrapSchema.parse(await bridge.snapshot())
  },
  async subscribe(topics, listener) {
    const bridge = requireBridge()
    return bridge.subscribe(topics, (event) => {
      listener(SubscriptionEventSchema.parse(event))
    })
  },
}

function requireBridge() {
  const bridge = getBridge()
  if (!bridge) {
    throw new Error('The Codexly desktop bridge is unavailable.')
  }
  return bridge
}
