import {
  desktopCapturer,
  dialog,
  globalShortcut,
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
import type { CanonicalSettings } from '../../src/shared/schemas/settings'
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
} from '../conversation/conversation-runtime'
import type { TurnEventEnvelope } from '../conversation/turn-controller'
import { AtomicJsonStore } from '../persistence/atomic-json-store'
import { SessionStore, type SessionRecord } from '../persistence/session-store'
import { SettingsStore } from '../persistence/settings-store'
import { WorkspaceStore } from '../persistence/workspace-store'
import { ShortcutManager } from '../shortcuts/shortcut-manager'

const CredentialRecordSchema = z
  .object({ version: z.literal(1), encryptedApiKey: z.string().nullable() })
  .strict()

type RuntimeStatus = Readonly<{
  state: 'ready' | 'offline' | 'unauthorized'
  authMode: 'chatgpt-local' | 'api-key'
  detail: string
}>

export interface ProductControllerOptions {
  userDataPath: string
  isPackaged: boolean
  resourcesPath: string
  windowManager: WindowManager
  publish(event: ProductEvent, roles?: readonly WindowRole[]): void
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
  readonly #turnOrigins = new Map<string, TurnOrigin>()
  readonly #assistantBuffers = new Map<string, string>()
  readonly #pendingAttachmentIds: string[] = []
  readonly #userDataPath: string
  #runtimeError: string | null = null
  #screenAccessEnsured = false

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
    this.#shortcuts = new ShortcutManager({ adapter: globalShortcut })
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

    try {
      const settings = await this.#settings.load()
      this.#windowManager.setOverlayContentProtection(settings.privacy.stealthMode)
    } catch {
      // Stealth defaults to on inside the window manager if settings are unreadable.
    }

    const capture = async () => {
      await this.#captureDisplay()
    }
    this.#shortcuts.configure({
      summonOverlay: {
        accelerator: 'CommandOrControl+Shift+Space',
        callback: async () => {
          await this.#windowManager.showOverlay()
        },
      },
      toggleOverlay: {
        accelerator: 'CommandOrControl+B',
        callback: () => this.#toggleOverlay(),
      },
      captureDisplay: {
        accelerator: 'CommandOrControl+H',
        callback: capture,
      },
      captureSelection: {
        accelerator: 'CommandOrControl+Shift+H',
        callback: async () => {
          await this.#captureSelection()
        },
      },
      solve: {
        accelerator: 'CommandOrControl+Enter',
        callback: async () => {
          await this.#solvePending(await this.#defaultModelId())
        },
      },
      clearBuffer: {
        accelerator: 'CommandOrControl+K',
        callback: () => this.#clearPendingAttachments(),
      },
      resetSession: {
        accelerator: 'CommandOrControl+R',
        callback: async () => {
          await this.#clearPendingAttachments()
          await this.#sessions.create({ workspaceId: (await this.#workspaces.getSelected())?.id ?? null })
        },
      },
      moveLeft: { accelerator: 'CommandOrControl+Left', callback: () => this.#moveOverlay(-40, 0) },
      moveRight: { accelerator: 'CommandOrControl+Right', callback: () => this.#moveOverlay(40, 0) },
      moveUp: { accelerator: 'CommandOrControl+Up', callback: () => this.#moveOverlay(0, -40) },
      moveDown: { accelerator: 'CommandOrControl+Down', callback: () => this.#moveOverlay(0, 40) },
      cancelCapture: {
        accelerator: 'Escape',
        dispatch: 'immediate',
        callback: () => {
          this.#capture.cancel()
        },
      },
    })
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
        return this.#runtimeStatus()
      case 'auth.setApiKey':
        await this.#credentials.setApiKey(command.apiKey, { persist: command.persist })
        return this.#runtimeStatus()
      case 'settings.get':
        return this.#settings.load()
      case 'settings.update':
        return this.#updateSettings(command.settings)
      case 'sessions.list':
        return this.#sessions.list()
      case 'sessions.get':
        return this.#sessions.get(command.sessionId)
      case 'sessions.create':
        return this.#sessions.create({
          workspaceId: (await this.#workspaces.getSelected())?.id ?? null,
        })
      case 'sessions.delete':
        return this.#sessions.delete(command.sessionId)
      case 'sessions.reactivate':
        return this.#sessions.reactivate(command.sessionId)
      case 'workspaces.list':
        return this.#workspaces.list()
      case 'workspaces.pick': {
        this.#requireHomepage(role)
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        return this.#workspaces.registerApprovedPath(result.filePaths[0])
      }
      case 'workspaces.select':
        return this.#workspaces.select(command.workspaceId)
      case 'workspaces.remove':
        return this.#workspaces.remove(command.workspaceId)
      case 'conversation.send':
        return this.#send(command, role === 'homepage' ? 'homepage' : 'overlay')
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
      case 'attachments.discard': {
        const removed = await this.#attachments.discardPending(command.attachmentId)
        const index = this.#pendingAttachmentIds.indexOf(command.attachmentId)
        if (index >= 0) this.#pendingAttachmentIds.splice(index, 1)
        return removed
      }
      case 'attachments.clear':
        await this.#clearPendingAttachments()
        return null
      case 'window.openHome':
        this.#windowManager.showHomepage()
        return null
      case 'window.toggleOverlay':
        await this.#toggleOverlay()
        return null
      case 'window.resizeOverlay': {
        const overlay = this.#windowManager.getWindow('overlay')
        if (overlay) overlay.setContentSize(command.width, command.height)
        return null
      }
    }
  }

  /** Captures the active display; used by the tray "Take Screenshot" action. */
  async captureActiveDisplay(): Promise<void> {
    await this.#captureDisplay()
  }

  async dispose(): Promise<void> {
    this.#shortcuts.dispose()
    await this.#runtime?.dispose()
  }

  async #send(
    command: Extract<ProductCommand, { type: 'conversation.send' }>,
    origin: TurnOrigin,
  ) {
    if (!this.#runtime) throw new Error(this.#runtimeError ?? 'Codex runtime is unavailable.')
    const workspace = await this.#workspaces.getSelected()
    if (!workspace) throw new Error('Select a workspace before sending a message.')
    const session = command.sessionId
      ? await this.#requireSession(command.sessionId)
      : (await this.#sessions.getActive()) ??
        (await this.#sessions.create({ workspaceId: workspace.id }))
    // Registered by session (before the turn starts) so streamed events can
    // always resolve which surface initiated the turn.
    this.#turnOrigins.set(session.id, origin)
    const now = new Date().toISOString()
    await this.#sessions.appendMessage(session.id, {
      id: crypto.randomUUID(),
      role: 'user',
      content: command.message,
      attachmentIds: command.attachmentIds,
      createdAt: now,
    })
    await Promise.all(
      command.attachmentIds.map((id) =>
        this.#attachments.associate(id, { ownerType: 'session', ownerId: session.id }),
      ),
    )
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
    const settings = await this.#settings.load()
    // Text-only turns run at 'minimal' effort; image turns use the configured
    // effort and may enable web search when the user opted in.
    const textOnlyTurn = attachments.length === 0
    const reasoningEffort = textOnlyTurn ? 'minimal' : settings.assistant.reasoningEffort
    const webSearch = !textOnlyTurn && settings.assistant.webSearchEnabled
    const handle = await this.#runtime.startTurn({
      conversationId: session.id,
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
    this.#activeTurns.set(handle.turnId, { sessionId: session.id, abort: handle.abort })
    void handle.completion.finally(() => this.#activeTurns.delete(handle.turnId))
    return { sessionId: session.id, turnId: handle.turnId }
  }

  async #solvePending(modelId: string) {
    if (this.#pendingAttachmentIds.length === 0) {
      throw new Error('There are no screenshots to process.')
    }
    return this.#send(
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
    const next = await this.#settings.update(() => settings)
    this.#windowManager.setOverlayContentProtection(next.privacy.stealthMode)
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

  async #providerRevisionInput() {
    const workspace = await this.#workspaces.getSelected()
    const settings = await this.#settings.load().catch(() => null)
    return {
      workspacePath: workspace?.canonicalPath ?? os.homedir(),
      workspaceRevision: workspace ? Number(new Date(workspace.updatedAt)) : 0,
      configRevision: this.#credentials.getStatus().revision,
      webSearch: settings?.assistant.webSearchEnabled ?? false,
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
          preview: `data:${attachment.mimeType};base64,${verified.bytes.toString('base64')}`,
        }
      }),
    )
  }

  async #clearPendingAttachments(): Promise<void> {
    const ids = this.#pendingAttachmentIds.splice(0)
    await Promise.all(ids.map((id) => this.#attachments.discardPending(id).catch(() => false)))
    this.#publish({ type: 'attachments.cleared' }, ['overlay'])
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
        preview: `data:${outcome.attachment.mimeType};base64,${verified.bytes.toString('base64')}`,
      }
      this.#publish({ type: 'attachment.captured', attachment }, ['overlay'])
      return { ...outcome, attachment }
    }
    return outcome
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
  }

  async #toggleOverlay(): Promise<void> {
    const overlay = this.#windowManager.getWindow('overlay')
    if (overlay?.isVisible()) await this.#windowManager.hideOverlay()
    else await this.#windowManager.showOverlay()
  }

  #moveOverlay(deltaX: number, deltaY: number): void {
    const overlay = this.#windowManager.getWindow('overlay')
    if (!overlay) return
    const bounds = overlay.getBounds()
    overlay.setPosition(bounds.x + deltaX, bounds.y + deltaY)
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
      getThreadId: async (conversationId) =>
        (await this.#sessions.get(conversationId))?.codexThreadId ?? null,
      setThreadId: async (conversationId, threadId) => {
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
    const { conversationId: sessionId, turnId, event } = envelope
    const origin = this.#turnOrigins.get(sessionId) ?? 'overlay'
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
      await this.#sessions.appendToolEvent(sessionId, {
        id: `${turnId}-${event.activity.id}-${envelope.sequence}`,
        name: event.activity.title ?? event.activity.kind,
        state: event.type === 'activity.started' ? 'started' : event.activity.status === 'failed' ? 'failed' : 'completed',
        input: event.activity.details,
        createdAt: envelope.occurredAt,
      })
      this.#publish({
        type: 'tool.status',
        sessionId,
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
      if (content) {
        await this.#sessions.appendMessage(sessionId, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          attachmentIds: [],
          createdAt: envelope.occurredAt,
        })
      }
      await this.#sessions.setTerminalState(
        sessionId,
        event.type === 'turn.completed' ? 'completed' : event.type === 'turn.interrupted' ? 'cancelled' : 'failed',
      )
      if (event.type === 'turn.completed') {
        await this.#maybeTitleSession(sessionId)
      }
      if (event.type === 'turn.failed') {
        this.#publish({ type: 'transcript.failed', sessionId, turnId, origin, message: event.message })
      } else {
        this.#publish({ type: 'transcript.complete', sessionId, turnId, origin })
      }
      this.#publish({ type: 'sessions.changed' }, ['homepage'])
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
        if (homepage) {
          homepage.setBounds(snapshot.homepage.bounds)
          if (snapshot.homepage.visible) homepage.show()
          if (snapshot.homepage.focused) homepage.focus()
        }
        if (overlay) {
          overlay.setBounds(snapshot.overlay.bounds)
          overlay.setIgnoreMouseEvents(snapshot.overlay.clickThrough)
          if (snapshot.overlay.visible) await this.#windowManager.showOverlay()
        }
      },
    }
  }

  async #requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.#sessions.get(sessionId)
    if (!session) throw new Error('The session does not exist.')
    return session
  }

  #requireHomepage(role: WindowRole): void {
    if (role !== 'homepage') throw new Error('This action is available only from the homepage.')
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
