import {
  desktopCapturer,
  dialog,
  globalShortcut,
  safeStorage,
  screen,
  type BrowserWindow,
  type NativeImage,
} from 'electron'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import type { ProductCommand, ProductEvent } from '../../src/shared/ipc/product'
import type { WindowRole } from '../windows/window-options'
import type { WindowManager } from '../windows/window-manager'
import { CredentialStore } from '../auth/credential-store'
import { AttachmentStore } from '../capture/attachment-store'
import {
  CaptureCoordinator,
  type CapturePresentationSnapshot,
} from '../capture/capture-coordinator'
import { DisplayCapture } from '../capture/display-capture'
import { displayAtPoint } from '../capture/selection-models'
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
  readonly #assistantBuffers = new Map<string, string>()
  readonly #pendingAttachmentIds: string[] = []
  #runtimeError: string | null = null

  static async create(options: ProductControllerOptions): Promise<ProductController> {
    const controller = new ProductController(options)
    await controller.#initialize()
    return controller
  }

  private constructor(options: ProductControllerOptions) {
    this.#windowManager = options.windowManager
    this.#publish = options.publish
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
    const home = os.homedir()
    try {
      if (!(await this.#workspaces.getSelected())) {
        await this.#workspaces.registerApprovedPath(home, 'Home')
      }
    } catch {
      // Workspace selection remains optional when the home directory is unavailable.
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
        callback: capture,
      },
      solve: {
        accelerator: 'CommandOrControl+Enter',
        callback: async () => {
          await this.#solvePending('gpt-5.5')
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
      case 'auth.useChatGpt':
        await this.#credentials.useChatGptLocalLogin()
        return this.#runtimeStatus()
      case 'auth.setApiKey':
        await this.#credentials.setApiKey(command.apiKey, { persist: command.persist })
        return this.#runtimeStatus()
      case 'settings.get':
        return this.#settings.load()
      case 'settings.update':
        return this.#settings.save(command.settings)
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
        return this.#send(command)
      case 'conversation.stop':
        return this.#stop(command.turnId)
      case 'conversation.solvePending':
        return this.#solvePending(command.modelId)
      case 'attachments.capture':
        return this.#captureDisplay()
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

  async dispose(): Promise<void> {
    this.#shortcuts.dispose()
    await this.#runtime?.dispose()
  }

  async #send(command: Extract<ProductCommand, { type: 'conversation.send' }>) {
    if (!this.#runtime) throw new Error(this.#runtimeError ?? 'Codex runtime is unavailable.')
    const workspace = await this.#workspaces.getSelected()
    if (!workspace) throw new Error('Select a workspace before sending a message.')
    const session = command.sessionId
      ? await this.#requireSession(command.sessionId)
      : (await this.#sessions.getActive()) ??
        (await this.#sessions.create({ workspaceId: workspace.id }))
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
    const handle = await this.#runtime.startTurn({
      conversationId: session.id,
      modelId: command.modelId,
      message: command.message,
      attachments,
      workspacePath: workspace.canonicalPath,
      workspaceRevision: Number(new Date(workspace.updatedAt)),
      configRevision: this.#credentials.getStatus().revision,
    })
    this.#activeTurns.set(handle.turnId, { sessionId: session.id, abort: handle.abort })
    void handle.completion.finally(() => this.#activeTurns.delete(handle.turnId))
    return { sessionId: session.id, turnId: handle.turnId }
  }

  async #solvePending(modelId: string) {
    if (this.#pendingAttachmentIds.length === 0) {
      throw new Error('There are no screenshots to process.')
    }
    return this.#send({
      type: 'conversation.send',
      message: 'Analyze the attached screenshots and provide the most useful direct answer. If this is a coding problem, explain the approach and provide a complete solution.',
      modelId,
      attachmentIds: [...this.#pendingAttachmentIds],
    })
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
    const outcome = await this.#capture.capture({
      selectTarget: async (signal, displays) => {
        if (signal.aborted) throw signal.reason
        const display = displayAtPoint(displays, screen.getCursorScreenPoint()) ?? displays[0]
        if (!display) throw new Error('No display is available for capture.')
        return { kind: 'display', displayId: display.id }
      },
    })
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
    if (event.type === 'assistant.delta') {
      const text = (this.#assistantBuffers.get(turnId) ?? '') + event.text
      this.#assistantBuffers.set(turnId, text)
      this.#publish({ type: 'transcript.delta', sessionId, turnId, text: event.text })
      return
    }
    if (event.type === 'activity.started' || event.type === 'activity.completed') {
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
        name: event.activity.title ?? event.activity.kind,
        state: event.type === 'activity.started' ? 'running' : event.activity.status === 'failed' ? 'error' : 'complete',
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
      if (event.type === 'turn.failed') {
        this.#publish({ type: 'transcript.failed', sessionId, turnId, message: event.message })
      } else {
        this.#publish({ type: 'transcript.complete', sessionId, turnId })
      }
      this.#publish({ type: 'sessions.changed' }, ['homepage'])
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
