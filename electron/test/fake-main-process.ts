import type { MainProcessAdapters, PreviewImage, ScreenDisplay } from '../app/adapters'
import type { WindowManagerLike } from '../app/product-controller'
import type {
  AttachmentStoreLike,
  ConversationRuntimeLike,
  LegacyImportRunner,
  SessionStoreLike,
  SettingsStoreLike,
  WorkspaceStoreLike,
} from '../app/product-stores'
import type {
  AttachmentAssociation,
  AttachmentRecord,
  VerifiedAttachment,
} from '../capture/attachment-store'
import type { CaptureImage, ScreenCaptureSource } from '../capture/display-capture'
import type { CaptureTarget } from '../capture/selection-models'
import type { ConversationTurnHandle } from '../conversation/conversation-runtime'
import type { TurnEventEnvelope } from '../conversation/turn-controller'
import type { SessionRecord } from '../persistence/session-store'
import { DEFAULT_SETTINGS, type Settings } from '../persistence/settings-store'
import type { WorkspaceRecord } from '../persistence/workspace-store'
import type { ManagedWindow } from '../windows/window-manager'
import type { WindowRole } from '../windows/window-options'

/**
 * Substitutes for everything the main-process composition root depends on. They
 * are plain objects — no Electron, no filesystem, no timers — so a test can
 * build the REAL {@link ProductController} and observe it directly.
 */

const DEFAULT_DISPLAY: ScreenDisplay = {
  id: '1',
  label: 'Primary',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 2,
  rotation: 0,
}

export interface FakeAdapters {
  adapters: MainProcessAdapters
  /** Result the next region selection resolves with. */
  selectionResult: CaptureTarget | 'cancelled'
  registeredShortcuts: Map<string, () => void>
  openedUrls: string[]
  messageBoxResponse: number
  directoryResult: { canceled: boolean; filePaths: readonly string[] }
  screenAccess: string
  /** Advances the fake clock; every timestamp the controller writes is derived here. */
  advance(milliseconds: number): void
}

export function createFakeAdapters(
  overrides: Partial<MainProcessAdapters> = {},
): FakeAdapters {
  let clockMs = Date.UTC(2024, 0, 1)
  const fake: FakeAdapters = {
    selectionResult: 'cancelled',
    registeredShortcuts: new Map(),
    openedUrls: [],
    messageBoxResponse: 1,
    directoryResult: { canceled: true, filePaths: [] },
    screenAccess: 'granted',
    advance: (milliseconds) => {
      clockMs += milliseconds
    },
    adapters: {
      screen: {
        getAllDisplays: () => [DEFAULT_DISPLAY],
        getCursorPoint: () => ({ x: 10, y: 10 }),
        getDisplayIdMatching: () => DEFAULT_DISPLAY.id,
      },
      captureSources: {
        getSources: async () => [createFakeCaptureSource()],
      },
      dialog: {
        openDirectory: async () => fake.directoryResult,
        showMessageBoxSync: () => fake.messageBoxResponse,
      },
      shell: {
        openExternal: async (url) => {
          fake.openedUrls.push(url)
        },
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value) => Buffer.from(value, 'utf8'),
        decryptString: (value) => value.toString('utf8'),
      },
      globalShortcut: {
        register: (accelerator, callback) => {
          fake.registeredShortcuts.set(accelerator, callback)
          return true
        },
        unregister: (accelerator) => {
          fake.registeredShortcuts.delete(accelerator)
        },
      },
      systemPreferences: {
        getMediaAccessStatus: () => fake.screenAccess,
      },
      image: { createFromBuffer: (bytes) => createFakePreviewImage(bytes) },
      selection: {
        selectRegion: async () => fake.selectionResult,
        dispose: () => undefined,
      },
      clock: { now: () => new Date(clockMs) },
      env: {
        platform: 'linux',
        homedir: () => '/home/tester',
        readEnv: () => undefined,
      },
      ...overrides,
    },
  }
  return fake
}

function createFakePreviewImage(bytes: Buffer): PreviewImage {
  const image: PreviewImage = {
    getSize: () => ({ width: 1920, height: 1080 }),
    resize: () => image,
    toDataURL: () => `data:image/png;base64,preview-${bytes.byteLength}`,
  }
  return image
}

export function createFakeCaptureSource(): ScreenCaptureSource {
  const image: CaptureImage = {
    size: { width: 3840, height: 2160 },
    toPng: () => Buffer.from('png'),
    crop: () => image,
  }
  return { id: 'screen:1', displayId: DEFAULT_DISPLAY.id, name: 'Primary', image }
}

export class FakeSettingsStore implements SettingsStoreLike {
  #settings: Settings

  constructor(settings: Partial<Settings> = {}) {
    this.#settings = { ...DEFAULT_SETTINGS, ...settings }
  }

  async load(): Promise<Settings> {
    return this.#settings
  }

  async update(update: (current: Settings) => Settings): Promise<Settings> {
    this.#settings = update(this.#settings)
    return this.#settings
  }
}

export class FakeWorkspaceStore implements WorkspaceStoreLike {
  readonly workspaces: WorkspaceRecord[]
  selectedId: string | null

  constructor(workspaces: WorkspaceRecord[] = [createFakeWorkspace()]) {
    this.workspaces = workspaces
    this.selectedId = workspaces[0]?.id ?? null
  }

  async list(): Promise<WorkspaceRecord[]> {
    return [...this.workspaces]
  }

  async getSelected(): Promise<WorkspaceRecord | null> {
    return this.workspaces.find((workspace) => workspace.id === this.selectedId) ?? null
  }

  async select(workspaceId: string | null): Promise<WorkspaceRecord | null> {
    this.selectedId = workspaceId
    return this.getSelected()
  }

  async remove(workspaceId: string): Promise<boolean> {
    const index = this.workspaces.findIndex((workspace) => workspace.id === workspaceId)
    if (index < 0) return false
    this.workspaces.splice(index, 1)
    if (this.selectedId === workspaceId) this.selectedId = null
    return true
  }

  async registerApprovedPath(approvedPath: string, title?: string): Promise<WorkspaceRecord> {
    const workspace = createFakeWorkspace({
      id: `workspace_${'0'.repeat(8)}-0000-0000-0000-${String(this.workspaces.length).padStart(12, '0')}`,
      canonicalPath: approvedPath,
      title: title ?? approvedPath,
    })
    this.workspaces.push(workspace)
    this.selectedId = workspace.id
    return workspace
  }

  async importLegacyProfiles(): Promise<WorkspaceRecord[]> {
    return []
  }
}

export function createFakeWorkspace(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  const timestamp = new Date(Date.UTC(2024, 0, 1)).toISOString()
  return {
    id: 'workspace_11111111-1111-1111-1111-111111111111',
    title: 'Fixture',
    canonicalPath: '/home/tester/project',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

export class FakeSessionStore implements SessionStoreLike {
  readonly sessions = new Map<string, SessionRecord>()
  activeSessionId: string | null = null
  #counter = 0

  async list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workspaceId: session.workspaceId,
      terminalState: session.terminalState,
      messageCount: session.messages.length,
      codexThreadId: session.codexThreadId,
      continuation: session.continuation,
    }))
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null
  }

  async getActive(): Promise<SessionRecord | null> {
    return this.activeSessionId ? this.get(this.activeSessionId) : null
  }

  async create(input: { workspaceId?: string | null } = {}): Promise<SessionRecord> {
    this.#counter += 1
    const suffix = String(this.#counter).padStart(12, '0')
    const timestamp = new Date(Date.UTC(2024, 0, 1)).toISOString()
    const session: SessionRecord = {
      version: 1,
      id: `session_22222222-2222-2222-2222-${suffix}`,
      title: 'Untitled',
      createdAt: timestamp,
      updatedAt: timestamp,
      workspaceId: input.workspaceId ?? null,
      codexThreadId: null,
      terminalState: 'active',
      messages: [],
      toolEvents: [],
      attachmentIds: [],
      checkpoints: [],
      continuation: null,
    }
    this.sessions.set(session.id, session)
    this.activeSessionId = session.id
    return session
  }

  async delete(sessionId: string): Promise<boolean> {
    if (this.activeSessionId === sessionId) this.activeSessionId = null
    return this.sessions.delete(sessionId)
  }

  async reactivate(sessionId: string): Promise<SessionRecord> {
    const session = await this.#require(sessionId)
    this.activeSessionId = sessionId
    return session
  }

  async clearActive(): Promise<void> {
    this.activeSessionId = null
  }

  async update(
    sessionId: string,
    update: (current: SessionRecord) => SessionRecord,
  ): Promise<SessionRecord> {
    const next = update(await this.#require(sessionId))
    this.sessions.set(sessionId, next)
    return next
  }

  async appendMessage(
    sessionId: string,
    message: SessionRecord['messages'][number],
  ): Promise<SessionRecord> {
    return this.update(sessionId, (current) => ({
      ...current,
      messages: [...current.messages, message],
      attachmentIds: [...new Set([...current.attachmentIds, ...message.attachmentIds])],
    }))
  }

  async removeMessage(sessionId: string, messageId: string): Promise<SessionRecord> {
    return this.update(sessionId, (current) => ({
      ...current,
      messages: current.messages.filter((message) => message.id !== messageId),
    }))
  }

  async appendToolEvent(
    sessionId: string,
    event: SessionRecord['toolEvents'][number],
  ): Promise<SessionRecord> {
    return this.update(sessionId, (current) => ({
      ...current,
      toolEvents: [...current.toolEvents, event],
    }))
  }

  async setTerminalState(
    sessionId: string,
    terminalState: SessionRecord['terminalState'],
  ): Promise<SessionRecord> {
    return this.update(sessionId, (current) => ({ ...current, terminalState }))
  }

  async #require(sessionId: string): Promise<SessionRecord> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session
  }
}

export class FakeAttachmentStore implements AttachmentStoreLike {
  readonly attachments = new Map<string, AttachmentRecord>()
  readonly bytes = new Map<string, Buffer>()
  initialized = false
  #counter = 0

  async initialize(): Promise<void> {
    this.initialized = true
  }

  async list(): Promise<readonly AttachmentRecord[]> {
    return [...this.attachments.values()]
  }

  async addPendingImage(input: {
    name: string
    mimeType: AttachmentRecord['mimeType']
    bytes: Uint8Array
    width: number
    height: number
  }): Promise<AttachmentRecord> {
    this.#counter += 1
    const id = `aaaaaaaa-aaaa-aaaa-aaaa-${String(this.#counter).padStart(12, '0')}`
    const record: AttachmentRecord = {
      id,
      name: input.name,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      width: input.width,
      height: input.height,
      createdAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
      associations: [],
    }
    this.attachments.set(id, record)
    this.bytes.set(id, Buffer.from(input.bytes))
    return record
  }

  async discardPending(id: string): Promise<boolean> {
    this.bytes.delete(id)
    return this.attachments.delete(id)
  }

  async resolveVerifiedBytes(id: string): Promise<VerifiedAttachment> {
    const attachment = this.attachments.get(id)
    const bytes = this.bytes.get(id)
    if (!attachment || !bytes) throw new Error(`Unknown attachment: ${id}`)
    return { attachment, bytes }
  }

  async associateMany(
    attachmentIds: readonly string[],
    association: AttachmentAssociation,
  ): Promise<readonly AttachmentRecord[]> {
    return attachmentIds.map((id) => {
      const attachment = this.attachments.get(id)
      if (!attachment) throw new Error(`Unknown attachment: ${id}`)
      const next = { ...attachment, associations: [...attachment.associations, association] }
      this.attachments.set(id, next)
      return next
    })
  }

  async releaseAndDiscardMany(
    attachmentIds: readonly string[],
  ): Promise<Readonly<{ releasedIds: readonly string[]; removedIds: readonly string[] }>> {
    const releasedIds: string[] = []
    for (const id of attachmentIds) {
      if (!this.attachments.has(id)) continue
      releasedIds.push(id)
      await this.discardPending(id)
    }
    return { releasedIds, removedIds: releasedIds }
  }
}

/** A legacy import that does nothing, so no test touches the real state directory. */
export const noLegacyImport: LegacyImportRunner = {
  importOnce: async () => ({ imported: false }),
}

export interface FakeWindow extends ManagedWindow {
  visible: boolean
  focusCount: number
}

export function createFakeWindow(visible = false): FakeWindow {
  let bounds = { x: 0, y: 0, width: 900, height: 600 }
  let contentSize: [number, number] = [900, 600]
  const window: FakeWindow = {
    visible,
    focusCount: 0,
    webContents: {
      id: 1,
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      setBackgroundThrottling: () => undefined,
    },
    on: () => undefined,
    isDestroyed: () => false,
    isVisible: () => window.visible,
    isFocused: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => bounds,
    setBounds: (next) => {
      bounds = { ...next }
    },
    getContentSize: () => [...contentSize],
    setContentSize: (width, height) => {
      contentSize = [width, height]
    },
    setIgnoreMouseEvents: () => undefined,
    setFocusable: () => undefined,
    setContentProtection: () => undefined,
    setSkipTaskbar: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    setHiddenInMissionControl: () => undefined,
    setAlwaysOnTop: () => undefined,
    restore: () => undefined,
    show: () => {
      window.visible = true
    },
    showInactive: () => {
      window.visible = true
    },
    hide: () => {
      window.visible = false
    },
    focus: () => {
      window.focusCount += 1
    },
    blur: () => undefined,
    close: () => undefined,
    destroy: () => undefined,
    loadURL: async () => undefined,
    loadFile: async () => undefined,
  }
  return window
}

export class FakeWindowManager implements WindowManagerLike {
  readonly homepage = createFakeWindow(true)
  readonly overlay = createFakeWindow(false)
  readonly calls: string[] = []
  streaming = false
  focusable = false
  contentProtection = true

  getWindow(role: WindowRole): ManagedWindow | null {
    return role === 'homepage' ? this.homepage : this.overlay
  }

  showHomepage(): void {
    this.calls.push('showHomepage')
    this.homepage.visible = true
    this.overlay.visible = false
  }

  async showOverlay(): Promise<void> {
    this.calls.push('showOverlay')
    this.overlay.visible = true
    this.homepage.visible = false
  }

  async hideOverlay(): Promise<void> {
    this.calls.push('hideOverlay')
    this.overlay.visible = false
  }

  releaseOverlayFocus(): void {
    this.calls.push('releaseOverlayFocus')
  }

  setOverlayFocusable(focusable: boolean): void {
    this.focusable = focusable
  }

  async setOverlayStreaming(streaming: boolean): Promise<void> {
    this.streaming = streaming
  }

  setOverlayContentProtection(enabled: boolean): void {
    this.contentProtection = enabled
  }
}

export interface FakeTurn {
  turnId: string
  conversationId: string
  aborts: string[]
  settle(state: 'completed' | 'interrupted' | 'failed'): void
}

/**
 * A conversation runtime whose turn startup and event stream the test drives.
 * `gate` holds `startTurn` open so the controller can be observed while a turn
 * is still `initiating`.
 */
export class FakeConversationRuntime implements ConversationRuntimeLike {
  readonly started: Array<{ conversationId: string; turnId?: string; message: string }> = []
  readonly turns = new Map<string, FakeTurn>()
  readonly abortTurnCalls: Array<{ turnId: string; reason?: string }> = []
  readonly warmed: unknown[] = []
  disposed = false
  gate: Promise<void> | null = null

  constructor(private readonly events: { append(event: TurnEventEnvelope): Promise<void> }) {}

  async startTurn(input: {
    conversationId: string
    turnId?: string
    message: string
  }): Promise<ConversationTurnHandle> {
    this.started.push(input)
    const turnId = input.turnId ?? 'turn-fake'
    let settle: (state: 'completed' | 'interrupted' | 'failed') => void = () => undefined
    const completion = new Promise<'completed' | 'interrupted' | 'failed'>((resolve) => {
      settle = resolve
    })
    const turn: FakeTurn = {
      turnId,
      conversationId: input.conversationId,
      aborts: [],
      settle,
    }
    // Registered before the gate: the real runtime also knows the caller-supplied
    // turn id while startup is still in flight, which is what makes the
    // id-addressed abort reachable during 'initiating'.
    this.turns.set(turnId, turn)
    if (this.gate) await this.gate
    return {
      turnId,
      completion,
      abort: async (reason) => {
        turn.aborts.push(reason ?? 'unspecified')
        settle('interrupted')
        return true
      },
    }
  }

  async abortTurn(turnId: string, reason?: string): Promise<boolean> {
    this.abortTurnCalls.push({ turnId, reason })
    const turn = this.turns.get(turnId)
    if (!turn) return false
    turn.aborts.push(reason ?? 'unspecified')
    return true
  }

  /** Feeds one runtime event through the controller's event store. */
  emit(
    turnId: string,
    event: TurnEventEnvelope['event'],
    sequence = 1,
  ): Promise<void> {
    const turn = this.turns.get(turnId)
    return this.events.append({
      conversationId: turn?.conversationId ?? 'unknown',
      turnId,
      sequence,
      occurredAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
      event,
    })
  }

  async listModels() {
    return []
  }

  async testConnection() {
    return { success: true } as const
  }

  async warm(input: unknown): Promise<void> {
    this.warmed.push(input)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}
