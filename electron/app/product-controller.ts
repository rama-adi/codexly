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

import {
  TranscriptSnapshotSchema,
  type ProductCommand,
  type ProductEvent,
  type TranscriptSnapshot,
  type TurnOrigin,
} from '../../src/shared/ipc/product'
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
import { retry } from '../effects/retry'
import { AtomicJsonStore } from '../persistence/atomic-json-store'
import { SessionStore, type SessionRecord } from '../persistence/session-store'
import { SettingsStore } from '../persistence/settings-store'
import { WorkspaceStore } from '../persistence/workspace-store'
import { ShortcutManager } from '../shortcuts/shortcut-manager'
import { logger, serializeErrorForLog } from '../shared/logger'
import {
  decideTurnEventDisposition,
  isFreshOverlayOpen,
  mergePendingAttachmentIds,
  shouldOverlayStream,
  TurnRegistry,
} from './turn-registry'

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

/** Used only when the settings file cannot be read; logged when it happens. */
const FALLBACK_MODEL_ID = 'gpt-5.5'

const WARMUP_RETRY_ATTEMPTS = 3

/** How many finished turns stay re-syncable after their records are closed. */
const MAX_RETAINED_TERMINAL_SNAPSHOTS = 8

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

/**
 * Keeps the final transcript of the most recent turns after their records are
 * gone, so a renderer that only notices a dropped event on the terminal signal
 * can still re-sync — including for ephemeral sessions, which persist nothing.
 * Insertion order is oldest-first, so the eviction is a plain LRU by arrival.
 */
export function retainTranscriptSnapshot(
  retained: Map<string, TranscriptSnapshot>,
  snapshot: TranscriptSnapshot,
  limit = MAX_RETAINED_TERMINAL_SNAPSHOTS,
): void {
  retained.delete(snapshot.turnId)
  retained.set(snapshot.turnId, { ...snapshot, live: false })
  while (retained.size > limit) {
    const oldest = retained.keys().next()
    if (oldest.done) break
    retained.delete(oldest.value)
  }
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
  readonly #turns: TurnRegistry
  readonly #pendingAttachmentIds: string[] = []
  readonly #reservedAttachmentIds = new Set<string>()
  readonly #ephemeralSessions = new Map<string, SessionRecord>()
  readonly #ephemeralThreadIds = new Map<string, string | null>()
  /**
   * The final transcript of the most recent turns, kept after their records are
   * closed. A renderer that only notices a dropped event on the terminal signal
   * can still re-sync, including for ephemeral sessions that persist nothing.
   */
  readonly #terminalSnapshots = new Map<string, TranscriptSnapshot>()
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
      log.error('Codex runtime construction failed', error)
    }
    this.#runtime = runtime
    this.#turns = new TurnRegistry({
      // Reaches a turn whose handle has not attached yet: the runtime already
      // knows the caller-supplied turn id while startTurn is still resolving.
      fallbackAbort: async (turnId, reason) =>
        (await this.#runtime?.abortTurn(turnId, reason)) ?? false,
    })

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
    } catch (error) {
      // Workspace selection remains optional when the home directory is unavailable.
      log.warn('default workspace registration failed', {
        home,
        error: serializeErrorForLog(error),
      })
    }

    let shortcuts: Shortcuts = { ...DEFAULT_SHORTCUTS }
    try {
      const settings = await this.#settings.load()
      this.#windowManager.setOverlayContentProtection(settings.privacy.stealthMode)
      shortcuts = settings.shortcuts
    } catch (error) {
      // Stealth defaults to on inside the window manager if settings are unreadable.
      // Shortcuts fall back to their documented defaults — which silently
      // replaces the user's custom accelerators, so this must be visible.
      log.error('settings load failed; reverting shortcuts to defaults', error, {
        shortcuts: DEFAULT_SHORTCUTS,
      })
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
      case 'conversation.transcriptSnapshot':
        return this.#transcriptSnapshot(command.turnId)
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
    await this.#turns.closeAll('Product controller disposed')
    this.#terminalSnapshots.clear()
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
    const messageId = crypto.randomUUID()
    const association = { ownerType: 'session' as const, ownerId: session.id }
    let handle: ConversationTurnHandle | null = null
    // Registered synchronously, before the first await of turn startup: the
    // id-free abort paths and the overlay fresh-session check must be able to
    // see this turn while the runtime is still starting it.
    const record = this.#turns.register({
      turnId,
      conversationId: session.id,
      origin,
      persistConversation,
    })
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
      // Any abort that arrived while the turn was initiating fires here.
      record.attachAbort(handle)
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
      await record.requestAbort('Turn setup failed').catch(() => false)
      // Compensating writes for a turn that never became live. They are not
      // scope finalizers: an ephemeral session must survive a successful turn.
      if (createdSession) {
        await this.#sessions.delete(session.id).catch(() => false)
      }
      if (!persistConversation) this.#removeEphemeralSession(session.id)
      await record.close('Turn setup failed')
      await this.#syncOverlayStreaming()
      throw error
    }

    if (origin === 'overlay') {
      // Release focus only after startup and local bookkeeping have succeeded.
      this.#windowManager.releaseOverlayFocus()
    }
    await this.#syncOverlayStreaming()
    void handle.completion.finally(() => {
      record.markCompletionSettled()
      void this.#syncOverlayStreaming()
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
    const record = this.#turns.get(event.turnId)
    if (!record) {
      // The turn was finalized before it could be announced; the renderer never
      // learned about it, so there is nothing to start or replay.
      log.warn('skipping announcement for an already-finalized turn', {
        turnId: event.turnId,
        sessionId: event.sessionId,
      })
      return
    }
    // The drain awaits persistence between envelopes, and the provider keeps
    // producing during those awaits. Holding the turn in "draining" makes those
    // arrivals queue behind the backlog instead of being published from inside
    // one of the gaps, which is what would reorder the transcript.
    record.beginDrain()
    try {
      await announceTurnBeforeDeferredEvents(
        () => {
          this.#publish(event, roles)
          record.markAnnounced()
        },
        record.deferred,
        (envelope) => this.#recordTurnEventNow(envelope),
      )
    } finally {
      record.endDrain()
    }
  }

  /**
   * Answers a renderer that detected a dropped event: the authoritative
   * transcript for one turn, live from the registry when the turn is still
   * running, otherwise the retained final copy. `null` means the turn is unknown
   * here, in which case the caller must keep what it has.
   */
  #transcriptSnapshot(turnId: string): TranscriptSnapshot | null {
    const record = this.#turns.get(turnId)
    const snapshot = record?.transcriptSnapshot() ?? this.#terminalSnapshots.get(turnId) ?? null
    if (!snapshot) {
      log.warn('transcript snapshot requested for an unknown turn', { turnId })
      return null
    }
    return TranscriptSnapshotSchema.parse(snapshot)
  }

  /**
   * Drives the overlay streaming affordance from registry state rather than
   * per-turn toggles, so a superseded turn settling after a newer one started
   * cannot switch the affordance back off underneath it.
   */
  async #syncOverlayStreaming(): Promise<void> {
    const streaming = shouldOverlayStream(this.#turns.snapshots())
    await this.#windowManager.setOverlayStreaming(streaming).catch((error: unknown) => {
      log.warn('overlay streaming transition failed', {
        streaming,
        error: serializeErrorForLog(error),
      })
    })
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
    } catch (error) {
      log.error('settings load failed; falling back to the built-in model id', error, {
        modelId: FALLBACK_MODEL_ID,
      })
      return FALLBACK_MODEL_ID
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

  /**
   * Memoizes one warmup per (workspace, credential) key. A failed warmup clears
   * the memo so the next caller retries instead of inheriting the failure for
   * the rest of the process lifetime.
   */
  async #warmRuntime(): Promise<void> {
    const runtime = this.#runtime
    if (!runtime) return
    const input = await this.#providerRevisionInput()
    const key = JSON.stringify({
      workspacePath: input.workspacePath,
      credentialRevision: this.#credentials.getStatus().revision,
    })
    if (this.#warmup?.key === key) {
      return this.#warmup.promise
    }
    const promise = retry(
      {
        attempts: WARMUP_RETRY_ATTEMPTS,
        delayMs: (attempt) => 250 * 2 ** (attempt - 1),
      },
      () => runtime.warm(input),
    ).catch((error: unknown) => {
      if (this.#warmup?.promise === promise) this.#warmup = null
      log.warn('runtime warmup failed; the next send will retry', {
        workspacePath: input.workspacePath,
        attempts: WARMUP_RETRY_ATTEMPTS,
        error: serializeErrorForLog(error),
      })
    })
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
    } catch (error) {
      // A failed or absent legacy import must never block startup.
      log.warn('legacy state import failed', {
        legacyStatePath,
        error: serializeErrorForLog(error),
      })
    }
  }

  async #listPendingAttachments() {
    const before = [...this.#pendingAttachmentIds]
    const pending = (await this.#attachments.list()).filter(
      (attachment) => attachment.associations.length === 0,
    )
    // A capture that completed during the await above is already queued; merging
    // keeps it instead of clobbering it with the older listing.
    const merged = mergePendingAttachmentIds(
      before,
      this.#pendingAttachmentIds,
      pending.map((attachment) => attachment.id),
    )
    this.#pendingAttachmentIds.splice(0, this.#pendingAttachmentIds.length, ...merged)
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

  /** Aborts every turn of a session, including turns still initiating. */
  async #abortTurnsForSession(sessionId: string, reason: string): Promise<void> {
    await this.#turns.requestAbortWhere(
      (snapshot) => snapshot.conversationId === sessionId,
      reason,
    )
    await this.#syncOverlayStreaming()
  }

  /** Aborts every overlay turn, including turns still initiating. */
  async #abortOverlayTurns(reason: string): Promise<void> {
    await this.#turns.requestAbortWhere(
      (snapshot) => snapshot.origin === 'overlay',
      reason,
    )
    await this.#syncOverlayStreaming()
  }

  async #stop(turnId: string): Promise<boolean> {
    const record = this.#turns.get(turnId)
    if (record) return record.requestAbort('Stopped by user')
    // The record is gone (late stop, or a turn finalized between the renderer's
    // decision and this call); the runtime may still know the turn id.
    log.info('stop for an unregistered turn; falling back to the runtime', { turnId })
    return (await this.#runtime?.abortTurn(turnId, 'Stopped by user')) ?? false
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
    } catch (error) {
      log.warn('auto-answer skipped; settings are unreadable', {
        error: serializeErrorForLog(error),
      })
      return
    }
    if (this.#pendingAttachmentIds.length === 0) return
    if (this.#turns.hasActive('overlay')) return
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
      liveTurns: this.#turns.size,
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
   * of resuming the last active one — except while a turn is still live or when
   * the caller explicitly continues a session (history "Continue").
   *
   * "Live" includes a turn that is still initiating: clearing the active session
   * under a mid-flight turn strands it, and in ephemeral mode the runtime's
   * thread-id callback then writes a session that was never persisted.
   */
  async openOverlay(preserveSession = false): Promise<void> {
    const snapshots = this.#turns.snapshots()
    const fresh = isFreshOverlayOpen(snapshots, preserveSession)
    log.info('openOverlay', {
      preserveSession,
      fresh,
      turnStates: snapshots.map((snapshot) => `${snapshot.origin}:${snapshot.state}`),
    })
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
    const record = this.#turns.get(envelope.turnId)
    switch (decideTurnEventDisposition(record?.snapshot())) {
      case 'defer':
        record?.deferred.push(envelope)
        return
      case 'drop':
        this.#logDroppedTurnEvent(envelope)
        return
      case 'deliver':
        await this.#recordTurnEventNow(envelope)
    }
  }

  #logDroppedTurnEvent(envelope: TurnEventEnvelope): void {
    log.warn('dropping a turn event with no live record', {
      turnId: envelope.turnId,
      sessionId: envelope.conversationId,
      eventType: envelope.event.type,
      sequence: envelope.sequence,
    })
  }

  async #recordTurnEventNow(envelope: TurnEventEnvelope): Promise<void> {
    const { conversationId: sessionId, turnId, event } = envelope
    const record = this.#turns.get(turnId)
    if (!record) {
      // Never guess the origin: a mis-routed event would drive the wrong surface.
      this.#logDroppedTurnEvent(envelope)
      return
    }
    const { origin, persistConversation } = record.context
    if (event.type === 'assistant.delta') {
      record.markStreaming()
      record.appendAssistantText(event.text)
      this.#publish({
        type: 'transcript.delta',
        sessionId,
        turnId,
        origin,
        sequence: record.nextSequence(),
        text: event.text,
      })
      return
    }
    if (event.type === 'reasoning.delta') {
      record.markStreaming()
      record.appendReasoningText(event.text)
      this.#publish({
        type: 'transcript.reasoning',
        sessionId,
        turnId,
        origin,
        sequence: record.nextSequence(),
        text: event.text,
      })
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
        }).catch((error: unknown) => {
          log.warn('tool event persistence failed', {
            sessionId,
            turnId,
            activityId: event.activity.id,
            error: serializeErrorForLog(error),
          })
        })
      }
      this.#publish({
        type: 'tool.status',
        sessionId,
        turnId,
        origin,
        sequence: record.nextSequence(),
        activityId: event.activity.id,
        name: event.activity.title ?? event.activity.kind,
        state: event.type === 'activity.started' ? 'running' : event.activity.status === 'failed' ? 'error' : 'complete',
        ...(detail ? { detail } : {}),
      })
      return
    }
    if (event.type === 'activity.output') {
      const text = truncateOutput(event.text)
      record.appendToolOutput(event.activityId, text)
      this.#publish({
        type: 'tool.output',
        sessionId,
        turnId,
        origin,
        sequence: record.nextSequence(),
        activityId: event.activityId,
        text,
        preliminary: event.preliminary,
      })
      return
    }
    if (event.type === 'turn.completed' || event.type === 'turn.interrupted' || event.type === 'turn.failed') {
      const content = record.assistantText
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
            this.#publish({
              type: 'transcript.failed',
              sessionId,
              turnId,
              origin,
              sequence: record.nextSequence(),
              message: failureMessage,
            })
          } else {
            this.#publish({
              type: 'transcript.complete',
              sessionId,
              turnId,
              origin,
              sequence: record.nextSequence(),
            })
          }
        })
      } finally {
        if (persistConversation) this.#publish({ type: 'sessions.changed' }, ['homepage'])
        // Retained before the record is torn down so a renderer that detects a
        // gap on the terminal event can still re-sync against the final text.
        retainTranscriptSnapshot(this.#terminalSnapshots, record.transcriptSnapshot())
        // The single cleanup path for a turn: every per-turn structure lives on
        // the record and its scope runs exactly once.
        await record.close(`turn ${event.type}`)
        await this.#syncOverlayStreaming()
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
    } catch (error) {
      // Titling is best-effort and must never disrupt turn completion.
      log.warn('session titling failed', {
        sessionId,
        error: serializeErrorForLog(error),
      })
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
