import type { Bootstrap } from '../shared/schemas/bootstrap'
import type { CanonicalSettings } from '../shared/schemas/settings'
import type {
  ConnectionTestResult,
  ModelOption,
} from '../shared/schemas/models'
import type { ProductEvent } from '../shared/ipc/product'
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
  runtimeStatus(): Promise<unknown>
  testConnection(): Promise<ConnectionTestResult>
  listModels(): Promise<ModelOption[]>
  useChatGpt(): Promise<unknown>
  setApiKey(apiKey: string, persist: boolean): Promise<unknown>
  getSettings(): Promise<CanonicalSettings>
  updateSettings(settings: CanonicalSettings): Promise<CanonicalSettings>
  listSessions(): Promise<unknown>
  getSession(sessionId: string): Promise<unknown>
  createSession(): Promise<unknown>
  deleteSession(sessionId: string): Promise<boolean>
  reactivateSession(sessionId: string): Promise<unknown>
  listWorkspaces(): Promise<unknown>
  pickWorkspace(): Promise<unknown>
  selectWorkspace(workspaceId: string): Promise<unknown>
  removeWorkspace(workspaceId: string): Promise<boolean>
  sendMessage(input: {
    sessionId?: string
    message: string
    modelId: string
    attachmentIds: string[]
  }): Promise<unknown>
  stopTurn(turnId: string): Promise<boolean>
  solvePending(modelId: string): Promise<unknown>
  capture(): Promise<unknown>
  captureSelection(): Promise<unknown>
  listAttachments(): Promise<unknown>
  discardAttachment(attachmentId: string): Promise<boolean>
  clearAttachments(): Promise<void>
  openHome(): Promise<void>
  toggleOverlay(preserveSession?: boolean): Promise<void>
  resizeOverlay(width: number, height: number): Promise<void>
  onProductEvent(listener: (event: ProductEvent) => void): () => void
}

export interface CodexlyDesktopBridge {
  readonly v1: CodexlyDesktopBridgeV1
}
