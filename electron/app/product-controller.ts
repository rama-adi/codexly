import {
  desktopCapturer,
  dialog,
  globalShortcut,
  nativeImage,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type BrowserWindow,
  type NativeImage,
} from 'electron'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type { ProductCommand, ProductEvent, TurnOrigin } from '../../src/shared/ipc/product'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type CanonicalSettings,
  type Shortcuts,
} from '../../src/shared/schemas/settings'
import type {
  ConnectionTestResult,
  ModelOption,
} from '../../src/shared/schemas/models'
import type { WindowRole } from '../windows/window-options'
import type { WindowManager } from '../windows/window-manager'
import type { PromptSettings } from '../conversation/prompt-builder'
import { sanitizeThreadTitle, TITLE_FALLBACK } from './thread-title'
import {
  LegacyImporter,
  type ImportedLegacySettings,
} from '../persistence/legacy-import'
import { CredentialStore } from '../auth/credential-store'
import { AttachmentStore } from '../capture/attachment-store'
import {
  CaptureCancelledError,
  CaptureCoordinator,
  type CapturePresentationSnapshot,
  type CaptureRequest,
} from '../capture/capture-coordinator'
import { DisplayCapture } from '../capture/display-capture'
import { displayAtPoint } from '../capture/selection-models'
import { selectCaptureRegion } from '../capture/selection-surface'
import {
  CodexProviderManager,
  resolvePinnedNativeCodexPath,
} from '../conversation/codex-provider-manager'
import {
  ConversationRuntime,
  type ConversationEventStore,
  type ConversationThreadStore,
  type ConversationTurnHandle,
} from '../conversation/conversation-runtime'
import type { TurnEventEnvelope } from '../conversation/turn-controller'
import { AtomicJsonStore } from '../persistence/atomic-json-store'
import { SessionStore, type SessionRecord } from '../persistence/session-store'
import { SettingsStore } from '../persistence/settings-store'
import { WorkspaceStore } from '../persistence/workspace-store'
import { ShortcutManager } from '../shortcuts/shortcut-manager'
import { logger } from '../shared/logger'

const log = logger.child('product')

const CredentialRecordSchema = z
  .object({ version: z.literal(1), encryptedApiKey: z.string().nullable() })
  .strict()

type RuntimeStatus = Readonly<{
  state: 'ready' | 'offline' | 'unauthorized'
  authMode: 'chatgpt-local' | 'api-key'
  detail: string
}>

/**
 * The default global-shortcut accelerators. Kept as a named export (and sourced
 * from the shared settings defaults) so the values have a single source of truth
 * across the main process, the renderer reset control, and tests.
 */
export const PRODUCT_SHORTCUT_ACCELERATORS = DEFAULT_SHORTCUTS

type TurnContext = Readonly<{
  origin: TurnOrigin
  persistConversation: boolean
}>

export interface ProductControllerOptions {
  userDataPath: string
  isPackaged: boolean
  resourcesPath: string
  windowManager: WindowManager
  publish(event: ProductEvent, roles?: readonly WindowRole[]): void
}

export function consumePendingAttachmentSnapshot(
  pendingIds: string[],
  consumedIds: readonly string[],
): void {
  const consumed = new Set(consumedIds)
  const remaining = pendingIds.filter((id) => !consumed.has(id))
  pendingIds.splice(0, pendingIds.length, ...remaining)
}

export async function consumePendingAttachmentsAfter<T>(
  pendingIds: string[],
  operation: (snapshot: readonly string[]) => Promise<T>,
): Promise<T> {
  const snapshot = [...pendingIds]
  const result = await operation(snapshot)
  consumePendingAttachmentSnapshot(pendingIds, snapshot)
  return result
}

export async function restoreCapturePresentation(
  snapshot: CapturePresentationSnapshot,
  homepage: BrowserWindow | null,
  overlay: BrowserWindow | null,
  showOverlay: () => Promise<void>,
): Promise<void> {
  if (homepage) {
    homepage.setBounds(snapshot.homepage.bounds)
    if (snapshot.homepage.visible) homepage.showInactive()
  }
  if (overlay) {
    overlay.setBounds(snapshot.overlay.bounds)
    overlay.setIgnoreMouseEvents(snapshot.overlay.clickThrough)
    if (snapshot.overlay.visible) await showOverlay()
  }
  // Visibility restoration must not steal focus from an external application.
  // Only a Codexly window that was key before capture is made key again.
  if (snapshot.homepage.focused) homepage?.focus()
  else if (snapshot.overlay.focused) overlay?.focus()
}

export async function announceTurnBeforeDeferredEvents(
  announce: () => void,
  deferred: TurnEventEnvelope[],
  record: (event: TurnEventEnvelope) => Promise<void>,
): Promise<void> {
  announce()
  while (deferred.length > 0) {
    await record(deferred.shift()!)
  }
}

export async function persistTurnSetupTransaction(options: Readonly<{
  attachmentIds: readonly string[]
  appendMessage: () => Promise<void>
  associateAll: (attachmentIds: readonly string[]) => Promise<void>
  removeMessage: () => Promise<void>
}>): Promise<void> {
  let messagePersisted = false
  try {
    await options.appendMessage()
    messagePersisted = true
    await options.associateAll(options.attachmentIds)
  } catch (error) {
    if (messagePersisted) await options.removeMessage().catch(() => undefined)
    throw error
  }
}

export async function persistTerminalBestEffort(
  operations: readonly (() => Promise<unknown>)[],
  publishTerminal: () => void,
): Promise<void> {
  for (const operation of operations) await operation().catch(() => undefined)
  publishTerminal()
}

const MAX_FALLBACK_PREVIEW_BYTES = 128 * 1024
const MAX_PREVIEW_DIMENSION = 128

export function createBoundedAttachmentPreview(
  bytes: Buffer,
  createImage: (bytes: Buffer) => Pick<NativeImage, 'getSize' | 'resize' | 'toDataURL'> = (value) =>
    nativeImage.createFromBuffer(value),
): string {
  try {
    const image = createImage(bytes)
    const size = image.getSize()
    const scale = Math.min(
      1,
      MAX_PREVIEW_DIMENSION / Math.max(1, size.width),
      MAX_PREVIEW_DIMENSION / Math.max(1, size.height),
    )
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    }).toDataURL()
  } catch {
    return bytes.byteLength <= MAX_FALLBACK_PREVIEW_BYTES
      ? `data:image/png;base64,${bytes.toString('base64')}`
      : ''
  }
}

type TerminalTurnEvent = Extract<
  TurnEventEnvelope['event'],
  { type: 'turn.completed' | 'turn.interrupted' | 'turn.failed' }
>

export function resolveTurnTerminalPresentation(
  event: TerminalTurnEvent,
  content: string,
): {
  hasAnswer: boolean
  state: 'completed' | 'cancelled' | 'failed'
  failureMessage?: string
} {
  const hasAnswer = content.trim().length > 0
  const failureMessage =
    event.type === 'turn.failed'
      ? event.message
      : !hasAnswer && event.type === 'turn.completed'
        ? 'Codex completed without returning an answer. Please try again.'
        : !hasAnswer && event.type === 'turn.interrupted'
          ? 'Response stopped before an answer was returned.'
          : undefined
  return {
    hasAnswer,
    state: failureMessage
      ? 'failed'
      : event.type === 'turn.completed'
        ? 'completed'
        : 'cancelled',
    ...(failureMessage ? { failureMessage } : {}),
  }
}

export class ProductController {
  readonly #settings: SettingsStore
  readonly #sessions: SessionStore
  readonly #workspaces: WorkspaceStore
  readonly #attachments: AttachmentStore
  readonly #credentials: CredentialStore
  readonly #windowManager: WindowManager
  readonly #publish: ProductControllerOptions['publish']
  readonly #runtime: ConversationRuntime | null
  readonly #capture: CaptureCoordinator
  readonly #shortcuts: ShortcutManager
  readonly #activeTurns = new Map<string, { sessionId: string; abort(reason?: string): Promise<boolean> }>()
  readonly #turnContexts = new Map<string, TurnContext>()
  readonly #initializingTurns = new Set<string>()
  readonly #deferredTurnEvents = new Map<string, TurnEventEnvelope[]>()
  readonly #assistantBuffers = new Map<string, string>()
  readonly #pendingAttachmentIds: string[] = []
  readonly #reservedAttachmentIds = new Set<string>()
  readonly #ephemeralSessions = new Map<string, SessionRecord>()
  readonly #ephemeralThreadIds = new Map<string, string | null>()
  readonly #userDataPath: string
  #runtimeError: string | null = null
  #screenAccessEnsured = false
  #warmup: { key: string; promise: Promise<void> } | null = null
  #activeEphemeralSessionId: string | null = null

  static async create(options: ProductControllerOptions): Promise<ProductController> {
    const controller = new ProductController(options)
    await controller.#initialize()
    return controller
  }

  private constructor(options: ProductControllerOptions) {
    this.#windowManager = options.windowManager
    this.#publish = options.publish
    this.#userDataPath = options.userDataPath
    this.#settings = new SettingsStore({ userDataPath: options.userDataPath })
    this.#sessions = new SessionStore({ userDataPath: options.userDataPath })
    this.#workspaces = new WorkspaceStore({
      userDataPath: options.userDataPath,
      allowedRootPaths: workspaceRoots(),
    })
    this.#attachments = new AttachmentStore({ userDataPath: options.userDataPath })

    const credentialRecord = new AtomicJsonStore({
      basePath: options.userDataPath,
      filename: 'credentials.json',
      schema: CredentialRecordSchema,
    })
    this.#credentials = new CredentialStore({
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (value) => safeStorage.encryptString(value),
        decryptString: (value) => safeStorage.decryptString(value),
      },
      persistence: {
        readEncryptedApiKey: async () =>
          (await credentialRecord.read())?.encryptedApiKey ?? null,
        writeEncryptedApiKey: async (value) => {
          await credentialRecord.write({ version: 1, encryptedApiKey: value })
        },
        deleteEncryptedApiKey: async () => {
          await credentialRecord.write({ version: 1, encryptedApiKey: null })
        },
      },
    })

    let runtime: ConversationRuntime | null = null
    try {
      const codexPath = resolvePinnedNativeCodexPath({
        isPackaged: options.isPackaged,
        resourcesPath: options.resourcesPath,
      })
      const providers = new CodexProviderManager({
        credentials: this.#credentials,
        codexPath,
        onToolRequestUserInput: async () => {
          throw new Error('Codex requested user input; explicit UI handling is required.')
        },
      })
      runtime = new ConversationRuntime({
        providers,
        threads: this.#createThreadStore(),
        events: this.#createEventStore(),
      })
    } catch (error) {
      this.#runtimeError = errorMessage(error)
    }
    this.#runtime = runtime

    const displayCapture = new DisplayCapture({
      getAllDisplays: () =>
        screen.getAllDisplays().map((display) => ({
          id: String(display.id),
          label: display.label || `Display ${display.id}`,
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
          rotation: normalizeRotation(display.rotation),
          physicalSize: {
            width: Math.round(display.bounds.width * display.scaleFactor),
            height: Math.round(display.bounds.height * display.scaleFactor),
          },
        })),
      getCursorPoint: () => screen.getCursorScreenPoint(),
      getSources: async (thumbnailSize) =>
        (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })).map(
          (source) => ({
            id: source.id,
            displayId: source.display_id || null,
            name: source.name,
            image: wrapNativeImage(source.thumbnail),
          }),
        ),
    })
    this.#capture = new CaptureCoordinator(
      displayCapture,
      this.#attachments,
      this.#createPresentationAdapter(),
    )
    this.#shortcuts = new ShortcutManager({
      adapter: globalShortcut,
      onError: (failure) => {
        this.#publish(
          {
            type: 'shortcut.error',
            action: failure.action,
            phase: failure.phase,
            message: errorMessage(failure.error),
          },
          ['homepage', 'overlay'],
        )
      },
    })
  }

  async #initialize(): Promise<void> {
    await Promise.all([this.#credentials.initialize(), this.#attachments.initialize()])
    // Read-only, one-time import of the legacy settings/profile surface. Must run
    // before the first settings load so imported preferences are visible.
    await this.#importLegacyState()
    const home = os.homedir()
    try {
      if (!(await this.#workspaces.getSelected())) {
        await this.#workspaces.registerApprovedPath(home, 'Home')
      }
    } catch {
      // Workspace selection remains optional when the home directory is unavailable.
    }

    let shortcuts: Shortcuts = { ...DEFAULT_SHORTCUTS }
    try {
      const settings = await this.#settings.load()
      this.#windowManager.setOverlayContentProtection(settings.privacy.stealthMode)
      shortcuts = settings.shortcuts
    } catch {
      // Stealth defaults to on inside the window manager if settings are unreadable.
      // Shortcuts fall back to their documented defaults.
    }
    this.#configureShortcuts(shortcuts)

    // Spawn and initialize the shared app-server in the background so the
    // first user turn normally arrives on an already-warm connection.
    void this.#warmRuntime()
  }

  async handle(command: ProductCommand, role: WindowRole): Promise<unknown> {
    switch (command.type) {
      case 'runtime.status':
        return this.#runtimeStatus()
      case 'runtime.testConnection':
        return this.#testConnection()
      case 'models.list':
        return this.#listModels()
      case 'auth.useChatGpt':
        await this.#credentials.useChatGptLocalLogin()
        void this.#warmRuntime()
        return this.#runtimeStatus()
      case 'auth.setApiKey':
        await this.#credentials.setApiKey(command.apiKey, { persist: command.persist })
        void this.#warmRuntime()
        return this.#runtimeStatus()
      case 'settings.get':
        return this.#settings.load()
      case 'settings.update':
        return this.#updateSettings(command.settings)
      case 'sessions.list':
        return this.#sessions.list()
      case 'sessions.get':
        return this.#ephemeralSessions.get(command.sessionId) ?? this.#sessions.get(command.sessionId)
      case 'sessions.create':
        if (role === 'overlay') {
          await this.#abortOverlayTurns('Session reset by user')
          await this.#clearPendingAttachments()
        }
        return this.#createSessionForCurrentPrivacy()
      case 'sessions.delete':
        return this.#deleteSession(command.sessionId)
      case 'sessions.reactivate':
        await this.#abortOverlayTurns('Another session was opened')
        if (!(await this.#settings.load()).privacy.persistConversations) {
          const workspace = await this.#workspaces.getSelected()
          if (!workspace) throw new Error('Select a workspace before starting a session.')
          return this.#createEphemeralSession(workspace.id)
        }
        return this.#sessions.reactivate(command.sessionId)
      case 'workspaces.list':
        return this.#workspaces.list()
      case 'workspaces.pick': {
        this.#requireHomepage(role)
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        const workspace = await this.#workspaces.registerApprovedPath(result.filePaths[0])
        void this.#warmRuntime()
        return workspace
      }
      case 'workspaces.select': {
        const workspace = await this.#workspaces.select(command.workspaceId)
        void this.#warmRuntime()
        return workspace
      }
      case 'workspaces.remove': {
        const removed = await this.#workspaces.remove(command.workspaceId)
        if (removed) void this.#warmRuntime()
        return removed
      }
      case 'conversation.send':
        return this.#sendFromSurface(command, role === 'homepage' ? 'homepage' : 'overlay')
      case 'conversation.stop':
        return this.#stop(command.turnId)
      case 'conversation.solvePending':
        return this.#solvePending(command.modelId)
      case 'attachments.capture':
        return this.#captureDisplay()
      case 'attachments.captureSelection':
        return this.#captureSelection()
      case 'attachments.list':
        return this.#listPendingAttachments()
      case 'attachments.getPreviews':
        return this.#getAttachmentPreviews(command.attachmentIds)
      case 'attachments.discard': {
        if (this.#reservedAttachmentIds.has(command.attachmentId)) return false
        const removed = await this.#attachments.discardPending(command.attachmentId)
        const index = this.#pendingAttachmentIds.indexOf(command.attachmentId)
        if (index >= 0) this.#pendingAttachmentIds.splice(index, 1)
        return removed
      }
      case 'attachments.clear':
        await this.#abortOverlayTurns('Cleared by user')
        await this.#clearPendingAttachments()
        return null
      case 'window.openHome':
        this.#windowManager.showHomepage()
        return null
      case 'window.toggleOverlay':
        await this.#toggleOverlay(command.preserveSession ?? false)
        return null
      case 'window.resizeOverlay': {
        const overlay = this.#windowManager.getWindow('overlay')
        if (overlay) {
          const [width, height] = overlay.getContentSize()
          if (width !== command.width || height !== command.height) {
            overlay.setContentSize(command.width, command.height)
          }
        }
        return null
      }
      case 'window.setOverlayFocusable':
        this.#windowManager.setOverlayFocusable(command.focusable)
        return null
    }
  }

  /** Captures the active display; used by the tray "Take Screenshot" action. */
  async captureActiveDisplay(): Promise<void> {
    await this.#captureDisplay()
  }

  async dispose(): Promise<void> {
    this.#shortcuts.dispose()
    await this.#runtime?.dispose()
    this.#activeTurns.clear()
    this.#turnContexts.clear()
    this.#initializingTurns.clear()
    this.#deferredTurnEvents.clear()
    this.#assistantBuffers.clear()
    this.#reservedAttachmentIds.clear()
    this.#ephemeralSessions.clear()
    this.#ephemeralThreadIds.clear()
    this.#activeEphemeralSessionId = null
    this.#warmup = null
  }

  async #send(
    command: Extract<ProductCommand, { type: 'conversation.send' }>,
    origin: TurnOrigin,
  ) {
    if (!this.#runtime) throw new Error(this.#runtimeError ?? 'Codex runtime is unavailable.')
    const workspace = await this.#workspaces.getSelected()
    if (!workspace) throw new Error('Select a workspace before sending a message.')
    const settings = await this.#settings.load()
    const persistenceEnabled = settings.privacy.persistConversations
    const activeSession = command.sessionId || !persistenceEnabled
      ? null
      : await this.#sessions.getActive()
    const ephemeral = command.sessionId
      ? this.#ephemeralSessions.get(command.sessionId) ?? null
      : this.#activeEphemeralSessionId
        ? this.#ephemeralSessions.get(this.#activeEphemeralSessionId) ?? null
        : null
    const createdSession = persistenceEnabled && !command.sessionId && !activeSession
    const session = !persistenceEnabled
      ? ephemeral ?? this.#createEphemeralSession(workspace.id)
      : command.sessionId
        ? ephemeral ?? (await this.#requireSession(command.sessionId))
        : activeSession ?? (await this.#sessions.create({ workspaceId: workspace.id }))
    const persistConversation = persistenceEnabled && !this.#ephemeralSessions.has(session.id)
    const attachments = await Promise.all(
      command.attachmentIds.map(async (id) => {
        const verified = await this.#attachments.resolveVerifiedBytes(id)
        return {
          name: verified.attachment.name,
          data: verified.bytes,
          mediaType: verified.attachment.mimeType,
        }
      }),
    )
    // Text-only turns run at 'minimal' effort; image turns use the configured
    // effort and may enable web search when the user opted in.
    const textOnlyTurn = attachments.length === 0
    const reasoningEffort = textOnlyTurn ? 'minimal' : settings.assistant.reasoningEffort
    const webSearch = !textOnlyTurn && settings.assistant.webSearchEnabled
    const turnId = crypto.randomUUID()
    const context: TurnContext = { origin, persistConversation }
    const messageId = crypto.randomUUID()
    const association = { ownerType: 'session' as const, ownerId: session.id }
    let handle: ConversationTurnHandle | null = null
    this.#turnContexts.set(turnId, context)
    this.#initializingTurns.add(turnId)
    try {
      handle = await this.#runtime.startTurn({
        conversationId: session.id,
        turnId,
        modelId: command.modelId,
        message: command.message,
        attachments,
        workspacePath: workspace.canonicalPath,
        workspaceRevision: Number(new Date(workspace.updatedAt)),
        configRevision: this.#credentials.getStatus().revision,
        webSearch,
        reasoningEffort,
        settings: toPromptSettings(settings),
      })
      if (persistConversation) {
        await persistTurnSetupTransaction({
          attachmentIds: command.attachmentIds,
          appendMessage: async () => {
            await this.#sessions.appendMessage(session.id, {
              id: messageId,
              role: 'user',
              content: command.message,
              attachmentIds: command.attachmentIds,
              createdAt: new Date().toISOString(),
            })
          },
          associateAll: async (ids) => {
            await this.#attachments.associateMany(ids, association)
          },
          removeMessage: async () => {
            await this.#sessions.removeMessage(session.id, messageId)
          },
        })
      }
    } catch (error) {
      if (handle) await handle.abort('Turn setup failed').catch(() => false)
      if (createdSession) {
        await this.#sessions.delete(session.id).catch(() => false)
      }
      if (!persistConversation) this.#removeEphemeralSession(session.id)
      this.#initializingTurns.delete(turnId)
      this.#deferredTurnEvents.delete(turnId)
      this.#turnContexts.delete(turnId)
      this.#assistantBuffers.delete(turnId)
      throw error
    }

    this.#activeTurns.set(turnId, { sessionId: session.id, abort: handle.abort })
    if (origin === 'overlay') {
      // Release focus only after startup and local bookkeeping have succeeded.
      this.#windowManager.releaseOverlayFocus()
      await this.#windowManager.setOverlayStreaming(true).catch(() => undefined)
    }
    void handle.completion.finally(() => {
      this.#activeTurns.delete(turnId)
      if (origin === 'overlay') {
        void this.#windowManager.setOverlayStreaming(false)
      }
    })
    return { sessionId: session.id, turnId, persistConversation }
  }

  async #sendFromSurface(
    command: Extract<ProductCommand, { type: 'conversation.send' }>,
    origin: TurnOrigin,
  ) {
    if (origin !== 'overlay') {
      const result = await this.#send(command, origin)
      const publicResult = {
        sessionId: result.sessionId,
        turnId: result.turnId,
        consumedAttachmentIds: [] as string[],
      }
      await this.#announceAndActivateTurn(
        { type: 'conversation.started', ...publicResult, origin },
        ['homepage'],
      )
      return publicResult
    }
    const pending = new Set(this.#pendingAttachmentIds)
    const consumedIds = command.attachmentIds.filter((id) => pending.has(id))
    if (consumedIds.some((id) => this.#reservedAttachmentIds.has(id))) {
      throw new Error('One or more screenshots are already being sent.')
    }
    consumedIds.forEach((id) => this.#reservedAttachmentIds.add(id))
    try {
      const result = await this.#send(command, origin)
      consumePendingAttachmentSnapshot(this.#pendingAttachmentIds, consumedIds)
      if (!result.persistConversation) {
        await Promise.all(
          consumedIds.map((id) => this.#attachments.discardPending(id).catch(() => false)),
        )
      }
      const publicResult = {
        sessionId: result.sessionId,
        turnId: result.turnId,
        consumedAttachmentIds: consumedIds,
      }
      await this.#announceAndActivateTurn(
        { type: 'conversation.started', ...publicResult, origin },
        ['overlay'],
      )
      return publicResult
    } finally {
      consumedIds.forEach((id) => this.#reservedAttachmentIds.delete(id))
    }
  }

  async #announceAndActivateTurn(
    event: Extract<ProductEvent, { type: 'conversation.started' }>,
    roles: readonly WindowRole[],
  ): Promise<void> {
    const deferred = this.#deferredTurnEvents.get(event.turnId) ?? []
    this.#deferredTurnEvents.set(event.turnId, deferred)
    try {
      await announceTurnBeforeDeferredEvents(
        () => this.#publish(event, roles),
        deferred,
        (envelope) => this.#recordTurnEventNow(envelope),
      )
    } finally {
      this.#deferredTurnEvents.delete(event.turnId)
      this.#initializingTurns.delete(event.turnId)
    }
  }

  async #solvePending(modelId: string) {
    if (this.#pendingAttachmentIds.length === 0) {
      throw new Error('There are no screenshots to process.')
    }
    return this.#sendFromSurface(
      {
        type: 'conversation.send',
        message: 'Analyze the attached screenshots and provide the most useful direct answer. If this is a coding problem, explain the approach and provide a complete solution.',
        modelId,
        attachmentIds: [...this.#pendingAttachmentIds],
      },
      'overlay',
    )
  }

  async #defaultModelId(): Promise<string> {
    try {
      return (await this.#settings.load()).assistant.model
    } catch {
      return 'gpt-5.5'
    }
  }

  async #updateSettings(settings: CanonicalSettings): Promise<CanonicalSettings> {
    const previous = await this.#settings.load().catch(() => null)
    const next = await this.#settings.update(() => settings)
    this.#windowManager.setOverlayContentProtection(next.privacy.stealthMode)
    if (!previous || !shortcutsEqual(previous.shortcuts, next.shortcuts)) {
      this.#configureShortcuts(next.shortcuts)
    }
    this.#publish({ type: 'settings.changed', settings: next }, ['homepage', 'overlay'])
    return next
  }

  async #listModels(): Promise<ModelOption[]> {
    if (!this.#runtime) throw new Error(this.#runtimeError ?? 'Codex runtime is unavailable.')
    return this.#runtime.listModels(await this.#providerRevisionInput())
  }

  async #testConnection(): Promise<ConnectionTestResult> {
    if (!this.#runtime) {
      return { success: false, error: this.#runtimeError ?? 'Codex runtime is unavailable.' }
    }
    return this.#runtime.testConnection(await this.#providerRevisionInput())
  }

  async #warmRuntime(): Promise<void> {
    if (!this.#runtime) return
    const input = await this.#providerRevisionInput()
    const key = JSON.stringify({
      workspacePath: input.workspacePath,
      credentialRevision: this.#credentials.getStatus().revision,
    })
    if (this.#warmup?.key === key) {
      return this.#warmup.promise
    }
    const promise = this.#runtime.warm(input).catch(() => undefined)
    this.#warmup = { key, promise }
    await promise
  }

  async #providerRevisionInput() {
    const workspace = await this.#workspaces.getSelected()
    return {
      workspacePath: workspace?.canonicalPath ?? os.homedir(),
      workspaceRevision: workspace ? Number(new Date(workspace.updatedAt)) : 0,
      configRevision: this.#credentials.getStatus().revision,
    }
  }

  async #importLegacyState(): Promise<void> {
    const base = process.env['CODEXLY_HOME']?.trim() || path.join(os.homedir(), '.codexly')
    const legacyStatePath = path.join(base, 'userdata')
    try {
      const importer = new LegacyImporter({
        userDataPath: this.#userDataPath,
        legacyStatePath,
        workspaceStore: this.#workspaces,
        importSettings: async (legacy) => {
          await this.#settings.update((current) => mergeLegacySettings(current, legacy))
        },
      })
      await importer.importOnce()
    } catch {
      // A failed or absent legacy import must never block startup.
    }
  }

  async #listPendingAttachments() {
    const pending = (await this.#attachments.list()).filter(
      (attachment) => attachment.associations.length === 0,
    )
    this.#pendingAttachmentIds.splice(0, this.#pendingAttachmentIds.length, ...pending.map((attachment) => attachment.id))
    return Promise.all(
      pending.map(async (attachment) => {
        const verified = await this.#attachments.resolveVerifiedBytes(attachment.id)
        return {
          ...attachment,
          preview: createBoundedAttachmentPreview(verified.bytes),
        }
      }),
    )
  }

  /**
   * Resolves stored attachments (e.g. screenshots from history) to bounded
   * preview data URLs by id. Unlike {@link #listPendingAttachments} this does
   * not filter by association, so already-sent attachments remain viewable.
   * Missing/unreadable ids are skipped rather than failing the whole request.
   */
  async #getAttachmentPreviews(
    attachmentIds: readonly string[],
  ): Promise<Array<{ id: string; name: string; preview: string }>> {
    const previews = await Promise.all(
      attachmentIds.map(async (id) => {
        try {
          const verified = await this.#attachments.resolveVerifiedBytes(id)
          return {
            id,
            name: verified.attachment.name,
            preview: createBoundedAttachmentPreview(verified.bytes),
          }
        } catch {
          return null
        }
      }),
    )
    return previews.filter((preview): preview is NonNullable<typeof preview> => preview !== null)
  }

  async #clearPendingAttachments(): Promise<void> {
    const ids = this.#pendingAttachmentIds.filter(
      (id) => !this.#reservedAttachmentIds.has(id),
    )
    consumePendingAttachmentSnapshot(this.#pendingAttachmentIds, ids)
    await Promise.all(ids.map((id) => this.#attachments.discardPending(id).catch(() => false)))
    this.#publish({ type: 'attachments.cleared' }, ['overlay'])
  }

  async #deleteSession(sessionId: string): Promise<boolean> {
    if (this.#ephemeralSessions.has(sessionId)) {
      await this.#abortTurnsForSession(sessionId, 'Session deleted by user')
      this.#removeEphemeralSession(sessionId)
      return true
    }
    const session = await this.#sessions.get(sessionId)
    if (!session) return false
    await this.#abortTurnsForSession(sessionId, 'Session deleted by user')
    const association = { ownerType: 'session' as const, ownerId: sessionId }
    await this.#attachments.releaseAndDiscardMany(session.attachmentIds, association)
    return this.#sessions.delete(sessionId)
  }

  async #abortTurnsForSession(sessionId: string, reason: string): Promise<void> {
    await Promise.all(
      [...this.#activeTurns.values()]
        .filter((turn) => turn.sessionId === sessionId)
        .map((turn) => turn.abort(reason)),
    )
  }

  async #abortOverlayTurns(reason: string): Promise<void> {
    await Promise.all(
      [...this.#activeTurns.entries()]
        .filter(([turnId]) => this.#turnContexts.get(turnId)?.origin === 'overlay')
        .map(([, turn]) => turn.abort(reason)),
    )
  }

  async #stop(turnId: string): Promise<boolean> {
    return (await this.#activeTurns.get(turnId)?.abort('Stopped by user')) ?? false
  }

  async #captureDisplay() {
    return this.#captureWithRequest({
      selectTarget: async (signal, displays) => {
        if (signal.aborted) throw signal.reason
        const display = displayAtPoint(displays, screen.getCursorScreenPoint()) ?? displays[0]
        if (!display) throw new Error('No display is available for capture.')
        return { kind: 'display', displayId: display.id }
      },
    })
  }

  async #captureSelection() {
    return this.#captureWithRequest({
      selectTarget: async (signal, displays) => {
        const result = await selectCaptureRegion(displays, signal)
        if (result === 'cancelled') throw new CaptureCancelledError()
        return result
      },
    })
  }

  async #captureWithRequest(request: CaptureRequest) {
    await this.#ensureScreenCaptureAccess()
    const outcome = await this.#capture.capture(request)
    if (outcome.kind === 'captured') {
      this.#pendingAttachmentIds.push(outcome.attachment.id)
      const verified = await this.#attachments.resolveVerifiedBytes(outcome.attachment.id)
      const attachment = {
        ...outcome.attachment,
        preview: createBoundedAttachmentPreview(verified.bytes),
      }
      this.#publish({ type: 'attachment.captured', attachment }, ['overlay'])
      // Auto-answer runs after the capture resolves so the queued attachment and
      // its preview reach the overlay first; it must not block the return value.
      void this.#maybeAutoAnswer()
      return { ...outcome, attachment }
    }
    return outcome
  }

  /**
   * When the user has opted into auto-answer, sends the freshly-queued
   * screenshot(s) to the assistant without a manual Solve. Skips silently while
   * an overlay turn is still streaming so rapid captures simply queue instead.
   */
  async #maybeAutoAnswer(): Promise<void> {
    let modelId: string
    try {
      const settings = await this.#settings.load()
      if (!settings.capture.autoAnswer) return
      modelId = settings.assistant.model
    } catch {
      return
    }
    if (this.#pendingAttachmentIds.length === 0) return
    if (this.#hasActiveOverlayTurn()) return
    try {
      // Surface the overlay if it is hidden so the streamed answer is visible.
      // preserveSession keeps any in-progress conversation and avoids clearing
      // the queue the capture just populated.
      if (!this.#windowManager.getWindow('overlay')?.isVisible()) {
        await this.openOverlay(true)
      }
      await this.#solvePending(modelId)
    } catch (error) {
      log.warn('auto-answer failed', { error: errorMessage(error) })
    }
  }

  #hasActiveOverlayTurn(): boolean {
    for (const context of this.#turnContexts.values()) {
      if (context.origin === 'overlay') return true
    }
    return false
  }

  /**
   * On macOS, verifies Screen Recording (TCC) access before the first capture.
   * Touching desktopCapturer triggers the system prompt; if still denied, offers
   * to open the relevant System Settings pane. No-op on other platforms.
   */
  async #ensureScreenCaptureAccess(): Promise<void> {
    if (process.platform !== 'darwin' || this.#screenAccessEnsured) return
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') {
      this.#screenAccessEnsured = true
      return
    }
    try {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      })
    } catch {
      // The TCC prompt itself can reject the probe; fall through to the dialog.
    }
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') {
      this.#screenAccessEnsured = true
      return
    }
    const response = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Open System Settings', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Screen Recording permission required',
      message: 'Codexly needs Screen Recording access to capture screenshots.',
      detail:
        'Enable it under Privacy & Security → Screen Recording, then quit and relaunch the app.',
    })
    if (response === 0) {
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      )
    }
    throw new Error(
      'Screen Recording permission is required. Enable Codexly in System Settings → Privacy & Security → Screen Recording, then relaunch the app.',
    )
  }

  /**
   * (Re)registers every global shortcut from the given accelerators and then
   * reports the resulting registration state so the UI can flag any that the OS
   * (or another app) refused. Re-running replaces the previous registrations.
   */
  #configureShortcuts(shortcuts: Shortcuts): void {
    this.#shortcuts.configure({
      summonOverlay: {
        accelerator: shortcuts.summonOverlay,
        callback: () => this.openOverlay(),
      },
      toggleOverlay: {
        accelerator: shortcuts.toggleOverlay,
        callback: () => this.#toggleOverlay(),
      },
      captureDisplay: {
        accelerator: shortcuts.captureDisplay,
        callback: async () => {
          await this.#captureDisplay()
        },
        dispatch: 'single-flight',
      },
      captureSelection: {
        accelerator: shortcuts.captureSelection,
        callback: async () => {
          await this.#captureSelection()
        },
        dispatch: 'single-flight',
      },
      solve: {
        accelerator: shortcuts.solve,
        callback: async () => {
          await this.#solvePending(await this.#defaultModelId())
        },
        dispatch: 'single-flight',
      },
    })
    this.#publishShortcutStatus()
  }

  #publishShortcutStatus(): void {
    const statuses: Record<
      string,
      { accelerator: string; registered: boolean; conflicted: boolean }
    > = {}
    for (const [action, status] of Object.entries(this.#shortcuts.getStatuses())) {
      statuses[action] = {
        accelerator: status.accelerator,
        registered: status.registered,
        conflicted: status.conflicted,
      }
    }
    this.#publish({ type: 'shortcut.status', statuses }, ['homepage', 'overlay'])
  }

  async #toggleOverlay(preserveSession = false): Promise<void> {
    const overlay = this.#windowManager.getWindow('overlay')
    log.info('toggleOverlay', {
      preserveSession,
      overlayVisible: overlay?.isVisible() ?? false,
      activeTurns: this.#activeTurns.size,
    })
    if (overlay?.isVisible()) {
      // The overlay and homepage are exclusive surfaces: dismissing the HUD
      // hands the screen back to the settings window rather than leaving the
      // app with no visible window.
      await this.#windowManager.hideOverlay()
      this.#windowManager.showHomepage()
    } else {
      await this.openOverlay(preserveSession)
    }
  }

  /**
   * Shows the overlay on user intent (shortcut, tray, toggle). Each open
   * starts a fresh conversation — the next send creates a new session instead
   * of resuming the last active one — except while a turn is still streaming
   * or when the caller explicitly continues a session (history "Continue").
   */
  async openOverlay(preserveSession = false): Promise<void> {
    const fresh = !preserveSession && this.#activeTurns.size === 0
    log.info('openOverlay', { preserveSession, fresh, activeTurns: this.#activeTurns.size })
    if (fresh) {
      await this.#sessions.clearActive()
      if (this.#activeEphemeralSessionId) {
        this.#removeEphemeralSession(this.#activeEphemeralSessionId)
      }
    }
    await this.#windowManager.showOverlay()
    const active = fresh
      ? null
      : this.#activeEphemeralSessionId
        ? this.#ephemeralSessions.get(this.#activeEphemeralSessionId) ?? null
        : await this.#sessions.getActive()
    this.#publish({ type: 'overlay.opened', fresh, sessionId: active?.id ?? null }, ['overlay'])
  }

  #runtimeStatus(): RuntimeStatus {
    const credentials = this.#credentials.getStatus()
    return {
      state: this.#runtime ? 'ready' : 'offline',
      authMode: credentials.mode,
      detail: this.#runtimeError ?? 'Codex CLI is available.',
    }
  }

  #createThreadStore(): ConversationThreadStore {
    return {
      getThreadId: async (conversationId) => {
        if (this.#ephemeralSessions.has(conversationId)) {
          return this.#ephemeralThreadIds.get(conversationId) ?? null
        }
        return (await this.#sessions.get(conversationId))?.codexThreadId ?? null
      },
      setThreadId: async (conversationId, threadId) => {
        if (this.#ephemeralSessions.has(conversationId)) {
          this.#ephemeralThreadIds.set(conversationId, threadId)
          return
        }
        await this.#sessions.update(conversationId, (current) => ({
          ...current,
          codexThreadId: threadId,
        }))
      },
    }
  }

  #createEventStore(): ConversationEventStore {
    return {
      append: async (envelope) => this.#recordTurnEvent(envelope),
    }
  }

  async #recordTurnEvent(envelope: TurnEventEnvelope): Promise<void> {
    if (this.#initializingTurns.has(envelope.turnId)) {
      const deferred = this.#deferredTurnEvents.get(envelope.turnId) ?? []
      deferred.push(envelope)
      this.#deferredTurnEvents.set(envelope.turnId, deferred)
      return
    }
    await this.#recordTurnEventNow(envelope)
  }

  async #recordTurnEventNow(envelope: TurnEventEnvelope): Promise<void> {
    const { conversationId: sessionId, turnId, event } = envelope
    const context = this.#turnContexts.get(turnId)
    const origin = context?.origin ?? 'overlay'
    const persistConversation = context?.persistConversation ?? true
    if (event.type === 'assistant.delta') {
      const text = (this.#assistantBuffers.get(turnId) ?? '') + event.text
      this.#assistantBuffers.set(turnId, text)
      this.#publish({ type: 'transcript.delta', sessionId, turnId, origin, text: event.text })
      return
    }
    if (event.type === 'reasoning.delta') {
      this.#publish({ type: 'transcript.reasoning', sessionId, turnId, origin, text: event.text })
      return
    }
    if (event.type === 'activity.started' || event.type === 'activity.completed') {
      // Conversation items (user/assistant text, reasoning) flow through the
      // transcript; only real tool work belongs in the activity feed.
      if (NON_TOOL_ACTIVITY_KINDS.has(event.activity.kind)) return
      const detail = describeActivityDetail(event.activity.details)
      if (persistConversation) {
        await this.#sessions.appendToolEvent(sessionId, {
          id: `${turnId}-${event.activity.id}-${envelope.sequence}`,
          name: event.activity.title ?? event.activity.kind,
          state: event.type === 'activity.started' ? 'started' : event.activity.status === 'failed' ? 'failed' : 'completed',
          input: event.activity.details,
          createdAt: envelope.occurredAt,
        }).catch(() => undefined)
      }
      this.#publish({
        type: 'tool.status',
        sessionId,
        turnId,
        origin,
        activityId: event.activity.id,
        name: event.activity.title ?? event.activity.kind,
        state: event.type === 'activity.started' ? 'running' : event.activity.status === 'failed' ? 'error' : 'complete',
        ...(detail ? { detail } : {}),
      })
      return
    }
    if (event.type === 'activity.output') {
      this.#publish({
        type: 'tool.output',
        sessionId,
        turnId,
        origin,
        activityId: event.activityId,
        text: truncateOutput(event.text),
        preliminary: event.preliminary,
      })
      return
    }
    if (event.type === 'turn.completed' || event.type === 'turn.interrupted' || event.type === 'turn.failed') {
      const content = this.#assistantBuffers.get(turnId) ?? ''
      this.#assistantBuffers.delete(turnId)
      const { hasAnswer, state, failureMessage } = resolveTurnTerminalPresentation(
        event,
        content,
      )
      try {
        const persistenceOperations: (() => Promise<unknown>)[] = []
        if (persistConversation && hasAnswer) {
          persistenceOperations.push(() => this.#sessions.appendMessage(sessionId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content,
            attachmentIds: [],
            createdAt: envelope.occurredAt,
          }))
        }
        if (persistConversation) {
          persistenceOperations.push(() => this.#sessions.setTerminalState(sessionId, state))
          if (event.type === 'turn.completed' && hasAnswer) {
            persistenceOperations.push(() => this.#maybeTitleSession(sessionId))
          }
        }
        await persistTerminalBestEffort(persistenceOperations, () => {
          if (failureMessage) {
            this.#publish({ type: 'transcript.failed', sessionId, turnId, origin, message: failureMessage })
          } else {
            this.#publish({ type: 'transcript.complete', sessionId, turnId, origin })
          }
        })
      } finally {
        if (persistConversation) this.#publish({ type: 'sessions.changed' }, ['homepage'])
        this.#turnContexts.delete(turnId)
        this.#assistantBuffers.delete(turnId)
        this.#deferredTurnEvents.delete(turnId)
      }
    }
  }

  /** Derives a session title from the first user message on first completion. */
  async #maybeTitleSession(sessionId: string): Promise<void> {
    try {
      const session = await this.#sessions.get(sessionId)
      if (!session || session.title.trim() !== TITLE_FALLBACK) return
      const firstUserMessage = session.messages.find((message) => message.role === 'user')
      if (!firstUserMessage?.content.trim()) return
      const title = sanitizeThreadTitle(firstUserMessage.content)
      if (title === TITLE_FALLBACK) return
      await this.#sessions.update(sessionId, (current) => ({ ...current, title }))
    } catch {
      // Titling is best-effort and must never disrupt turn completion.
    }
  }

  #createPresentationAdapter() {
    const read = (window: BrowserWindow | null) => ({
      visible: window?.isVisible() ?? false,
      focused: window?.isFocused() ?? false,
      clickThrough: false,
      displayId: window ? String(screen.getDisplayMatching(window.getBounds()).id) : '',
      bounds: window?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 },
    })
    return {
      snapshot: async () => ({
        homepage: read(this.#windowManager.getWindow('homepage')),
        overlay: read(this.#windowManager.getWindow('overlay')),
      }),
      prepareForCapture: async () => {
        this.#windowManager.getWindow('homepage')?.hide()
        await this.#windowManager.hideOverlay()
      },
      restore: async (snapshot: CapturePresentationSnapshot) => {
        const homepage = this.#windowManager.getWindow('homepage')
        const overlay = this.#windowManager.getWindow('overlay')
        await restoreCapturePresentation(
          snapshot,
          homepage,
          overlay,
          () => this.#windowManager.showOverlay(),
        )
      },
    }
  }

  async #requireSession(sessionId: string): Promise<SessionRecord> {
    const ephemeral = this.#ephemeralSessions.get(sessionId)
    if (ephemeral) return ephemeral
    const session = await this.#sessions.get(sessionId)
    if (!session) throw new Error('The session does not exist.')
    return session
  }

  #createEphemeralSession(workspaceId: string): SessionRecord {
    const now = new Date().toISOString()
    const session: SessionRecord = {
      version: 1,
      id: `session_${crypto.randomUUID()}`,
      title: TITLE_FALLBACK,
      createdAt: now,
      updatedAt: now,
      workspaceId,
      codexThreadId: null,
      terminalState: 'active',
      messages: [],
      toolEvents: [],
      attachmentIds: [],
      checkpoints: [],
      continuation: null,
    }
    this.#ephemeralSessions.set(session.id, session)
    this.#ephemeralThreadIds.set(session.id, null)
    this.#activeEphemeralSessionId = session.id
    return session
  }

  async #createSessionForCurrentPrivacy(): Promise<SessionRecord> {
    const workspaceId = (await this.#workspaces.getSelected())?.id ?? null
    if ((await this.#settings.load()).privacy.persistConversations) {
      return this.#sessions.create({ workspaceId })
    }
    if (!workspaceId) throw new Error('Select a workspace before starting a session.')
    return this.#createEphemeralSession(workspaceId)
  }

  #removeEphemeralSession(sessionId: string): void {
    this.#ephemeralSessions.delete(sessionId)
    this.#ephemeralThreadIds.delete(sessionId)
    if (this.#activeEphemeralSessionId === sessionId) this.#activeEphemeralSessionId = null
  }

  #requireHomepage(role: WindowRole): void {
    if (role !== 'homepage') {
      log.warn('Homepage-only action attempted from another surface', { role })
      throw new Error('This action is available only from the homepage.')
    }
  }
}

function workspaceRoots(): string[] {
  const home = os.homedir()
  const roots = [home, path.parse(home).root]
  return [...new Set(roots)]
}

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((rotation % 360) + 360) % 360
  return normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : 0
}

function wrapNativeImage(image: NativeImage) {
  const size = image.getSize()
  return {
    size,
    toPng: () => image.toPNG(),
    crop: (bounds: { x: number; y: number; width: number; height: number }) =>
      wrapNativeImage(image.crop(bounds)),
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function shortcutsEqual(a: Shortcuts, b: Shortcuts): boolean {
  return SHORTCUT_ACTIONS.every((action) => a[action] === b[action])
}

const MAX_TOOL_OUTPUT_LENGTH = 4000

function truncateOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_LENGTH
    ? `${text.slice(0, MAX_TOOL_OUTPUT_LENGTH)}…`
    : text
}

/** Codex thread items that are conversation content, not tool activity. */
const NON_TOOL_ACTIVITY_KINDS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan'])

/** Produces a compact, single-line detail string for a tool activity. */
function describeActivityDetail(details: unknown): string | undefined {
  if (details === null || details === undefined) return undefined
  const record =
    typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : null
  const candidate =
    record && typeof record.command === 'string'
      ? record.command
      : typeof details === 'string'
        ? details
        : JSON.stringify(details)
  const normalized = candidate.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized
}

function toPromptSettings(settings: CanonicalSettings): PromptSettings {
  return {
    mode: settings.assistant.mode,
    verbosity: settings.assistant.verbosity,
    codingLanguage: settings.assistant.codingLanguage,
    responseLanguage: settings.assistant.responseLanguage,
    customInstructionsEnabled: settings.assistant.customInstructionsEnabled,
    customInstructions: settings.assistant.customInstructions,
  }
}

/** Maps the read-only legacy settings surface onto the canonical settings shape. */
function mergeLegacySettings(
  current: CanonicalSettings,
  legacy: ImportedLegacySettings,
): CanonicalSettings {
  return {
    ...current,
    appearance: {
      ...current.appearance,
      answerHeight: legacy.answerHeight ?? current.appearance.answerHeight,
    },
    privacy: {
      ...current.privacy,
      stealthMode: legacy.stealthEnabled ?? current.privacy.stealthMode,
    },
    assistant: {
      ...current.assistant,
      model: legacy.model?.trim() || current.assistant.model,
      reasoningEffort: mapLegacyEffort(legacy.reasoningEffort) ?? current.assistant.reasoningEffort,
      responseLanguage: legacy.responseLanguage ?? current.assistant.responseLanguage,
      webSearchEnabled: legacy.webSearchEnabled ?? current.assistant.webSearchEnabled,
      mode:
        legacy.mode === 'coding'
          ? 'coding'
          : legacy.mode === 'simpleQA'
            ? 'question'
            : current.assistant.mode,
      verbosity:
        legacy.responseType === 'thorough'
          ? 'verbose'
          : legacy.responseType === 'concise'
            ? 'concise'
            : current.assistant.verbosity,
      codingLanguage: legacy.codingLanguage?.trim() || current.assistant.codingLanguage,
    },
  }
}

function mapLegacyEffort(
  effort: ImportedLegacySettings['reasoningEffort'],
): CanonicalSettings['assistant']['reasoningEffort'] | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
      return 'high'
    default:
      return undefined
  }
}
