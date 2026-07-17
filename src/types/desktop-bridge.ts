import type { Bootstrap } from '../shared/schemas/bootstrap'
import type {
  SubscriptionEvent,
  SubscriptionTopic,
} from '../shared/ipc/events'

export type DesktopSubscriptionListener = (event: SubscriptionEvent) => void
export type DesktopSubscriptionCleanup = () => Promise<void>

export interface CodexlyDesktopBridgeV1 {
  bootstrap(): Promise<Bootstrap>
  snapshot(): Promise<Bootstrap>
  subscribe(
    topics: readonly SubscriptionTopic[],
    listener: DesktopSubscriptionListener,
  ): Promise<DesktopSubscriptionCleanup>
}

export interface CodexlyDesktopBridge {
  readonly v1: CodexlyDesktopBridgeV1
}
