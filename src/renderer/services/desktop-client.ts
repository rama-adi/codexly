import { SubscriptionEventSchema } from '../../shared/ipc/events'
import { ConversationTurnResultSchema, type ProductEvent } from '../../shared/ipc/product'
import { BootstrapSchema } from '../../shared/schemas/bootstrap'
import {
  ConnectionTestResultSchema,
  ModelOptionsSchema,
} from '../../shared/schemas/models'
import { CanonicalSettingsSchema } from '../../shared/schemas/settings'
import type { CodexlyDesktopBridgeV1 } from '../../types/desktop-bridge'

export type RuntimeStatus = {
  state: 'ready' | 'offline' | 'unauthorized'
  authMode: 'chatgpt-local' | 'api-key'
  detail: string
}

export type SessionSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  terminalState: 'active' | 'completed' | 'failed' | 'cancelled'
  messageCount: number
}

export type SessionDetail = SessionSummary & {
  workspaceId: string | null
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    attachmentIds: string[]
    createdAt: string
  }>
  toolEvents: Array<{
    id: string
    name: string
    state: 'started' | 'completed' | 'failed'
    createdAt: string
  }>
}

export type Workspace = {
  id: string
  title: string
  canonicalPath: string
  createdAt: string
  updatedAt: string
}

const getBridge = (): CodexlyDesktopBridgeV1 | undefined =>
  typeof window === 'undefined' ? undefined : window.codexly?.v1

export const desktopClient = {
  get available() {
    return getBridge() !== undefined
  },
  async bootstrap() {
    return BootstrapSchema.parse(await requireBridge().bootstrap())
  },
  async snapshot() {
    return BootstrapSchema.parse(await requireBridge().snapshot())
  },
  async subscribe(topics: Parameters<CodexlyDesktopBridgeV1['subscribe']>[0], listener: Parameters<CodexlyDesktopBridgeV1['subscribe']>[1]) {
    return requireBridge().subscribe(topics, (event) =>
      listener(SubscriptionEventSchema.parse(event)),
    )
  },
  runtimeStatus: () => requireBridge().runtimeStatus() as Promise<RuntimeStatus>,
  async testConnection() {
    return ConnectionTestResultSchema.parse(await requireBridge().testConnection())
  },
  async listModels() {
    return ModelOptionsSchema.parse(await requireBridge().listModels())
  },
  useChatGpt: () => requireBridge().useChatGpt() as Promise<RuntimeStatus>,
  setApiKey: (apiKey: string, persist = true) =>
    requireBridge().setApiKey(apiKey, persist) as Promise<RuntimeStatus>,
  async getSettings() {
    return CanonicalSettingsSchema.parse(await requireBridge().getSettings())
  },
  async updateSettings(settings: Parameters<CodexlyDesktopBridgeV1['updateSettings']>[0]) {
    return CanonicalSettingsSchema.parse(await requireBridge().updateSettings(settings))
  },
  listSessions: () => requireBridge().listSessions() as Promise<SessionSummary[]>,
  getSession: (sessionId: string) =>
    requireBridge().getSession(sessionId) as Promise<SessionDetail | null>,
  createSession: () => requireBridge().createSession() as Promise<SessionDetail>,
  deleteSession: (sessionId: string) => requireBridge().deleteSession(sessionId),
  reactivateSession: (sessionId: string) =>
    requireBridge().reactivateSession(sessionId) as Promise<SessionDetail>,
  listWorkspaces: () => requireBridge().listWorkspaces() as Promise<Workspace[]>,
  pickWorkspace: () => requireBridge().pickWorkspace() as Promise<Workspace | null>,
  selectWorkspace: (workspaceId: string) =>
    requireBridge().selectWorkspace(workspaceId) as Promise<Workspace>,
  removeWorkspace: (workspaceId: string) => requireBridge().removeWorkspace(workspaceId),
  async sendMessage(input: Parameters<CodexlyDesktopBridgeV1['sendMessage']>[0]) {
    return ConversationTurnResultSchema.parse(await requireBridge().sendMessage(input))
  },
  stopTurn: (turnId: string) => requireBridge().stopTurn(turnId),
  async solvePending(modelId: string) {
    return ConversationTurnResultSchema.parse(await requireBridge().solvePending(modelId))
  },
  capture: () => requireBridge().capture() as Promise<unknown>,
  captureSelection: () => requireBridge().captureSelection() as Promise<unknown>,
  listAttachments: () => requireBridge().listAttachments() as Promise<Array<{ id: string; name: string; preview: string }>>,
  discardAttachment: (attachmentId: string) => requireBridge().discardAttachment(attachmentId),
  clearAttachments: () => requireBridge().clearAttachments(),
  openHome: () => requireBridge().openHome(),
  toggleOverlay: (preserveSession?: boolean) => requireBridge().toggleOverlay(preserveSession),
  resizeOverlay: (width: number, height: number) => requireBridge().resizeOverlay(width, height),
  onProductEvent(listener: (event: ProductEvent) => void) {
    return requireBridge().onProductEvent(listener)
  },
}

function requireBridge(): CodexlyDesktopBridgeV1 {
  const bridge = getBridge()
  if (!bridge) throw new Error('The Codexly desktop bridge is unavailable.')
  return bridge
}
