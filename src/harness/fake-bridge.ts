import type { RuntimeStatus, SessionDetail, SessionSummary, Workspace } from '../renderer/desktop'
import { createFixtureContext, type FixtureContext } from '../shared/fixtures/context'
import { makeBootstrap } from '../shared/fixtures/bootstrap'
import { makeConnectionTestResult, makeModelOptions } from '../shared/fixtures/models'
import { makeSettings } from '../shared/fixtures/settings'
import { SubscriptionEventSchema, type SubscriptionEvent } from '../shared/ipc/events'
import {
  ProductEventSchema,
  type ConversationTurnResult,
  type ProductEvent,
  type TranscriptSnapshot,
  type TurnOrigin,
} from '../shared/ipc/product'
import {
  type CanonicalSettings,
  CanonicalSettingsSchema,
} from '../shared/schemas/settings'
import type {
  CodexlyDesktopBridgeV1,
  DesktopSubscriptionCleanup,
  DesktopSubscriptionListener,
} from '../types/desktop-bridge'
import {
  createHarnessInitialState,
  makeHarnessAttachment,
  summarizeHarnessSession,
  type HarnessAttachment,
  type HarnessInitialState,
  type HarnessScenario,
} from './scenarios'
import {
  recordRecipe,
  type TurnRecipeName,
  type TurnRecording,
} from './turn-recipes'

export const HARNESS_MARKER = 'codexly-harness-fake-bridge'

const DEFAULT_FRAME_DELAY_MS = 30
const MAX_EVENT_LOG = 500
const MAX_RETAINED_SNAPSHOTS = 20
const MAX_QUEUED_ATTACHMENTS = 5

export interface FakeBridgeOptions {
  scenario: HarnessScenario
  /** Which surface the events belong to; the other surface ignores them. */
  origin: TurnOrigin
  /** Milliseconds between published frames. 0 in tests, ~30ms in a browser. */
  delayMs?: number
  /** Freeze every turn after this many published frames (0 = right after the announcement). */
  pauseAfter?: number
  context?: FixtureContext
  initial?: HarnessInitialState
}

export interface FakeTurnState {
  turnId: string
  sessionId: string
  sequence: number
  live: boolean
  recipe: TurnRecipeName
}

/** A plain, JSON-friendly view of everything the fake holds, for the inspector. */
export interface FakeBridgeState {
  scenario: string
  origin: TurnOrigin
  delayMs: number
  paused: boolean
  settings: CanonicalSettings
  sessions: SessionSummary[]
  activeSessionId: string | null
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  attachments: HarnessAttachment[]
  runtime: RuntimeStatus
  turns: FakeTurnState[]
  productListeners: number
  lastOverlaySize: { width: number; height: number } | null
  overlayFocusable: boolean
}

export interface FakeBridgeControls {
  readonly marker: string
  /** Bounded log of every product event the fake published, oldest first. */
  readonly events: readonly ProductEvent[]
  /** Start a scripted turn on the active session. Defaults to the scenario's recipe. */
  emitScript(recipe?: TurnRecipeName, options?: { pauseAfter?: number }): ConversationTurnResult
  /** Publish an arbitrary product event (validated by the contract). */
  emit(event: ProductEvent): void
  emitOverlayOpened(options?: { fresh?: boolean; sessionId?: string | null }): void
  /** Deliver a subscription event to every `subscribe()` listener. */
  emitSubscription(event: SubscriptionEvent): void
  setDelay(delayMs: number): void
  /** Freeze the player: no further frames publish until resume() or step(). */
  pause(): void
  /** Un-freeze the player and schedule every live turn's next frame. */
  resume(): void
  /** Publish exactly `count` frames (default 1) per live turn, then stay paused. */
  step(count?: number): void
  state(): FakeBridgeState
  /** Runs `callback` once, just after the renderer attaches its first listener. */
  whenListenersAttach(callback: () => void): void
  clearEvents(): void
  /** Cancels every scheduled frame. Safe to call twice. */
  dispose(): void
}

export type FakeBridge = CodexlyDesktopBridgeV1 & FakeBridgeControls

interface ActiveTurn {
  readonly recording: TurnRecording
  readonly recipe: TurnRecipeName
  index: number
  snapshot: TranscriptSnapshot
  timer: ReturnType<typeof setTimeout> | undefined
  finished: boolean
  /** Remaining frames before the player auto-pauses; undefined = never. */
  pauseBudget: number | undefined
}

const STOPPED_WITHOUT_ANSWER = 'Response stopped before an answer was returned.'

/**
 * A complete in-memory `CodexlyDesktopBridgeV1`, backed by the shared fixtures.
 * It is the harness' stand-in for preload + main: settings, sessions, workspaces
 * and the screenshot queue live in this closure, and a turn is a scripted
 * recording whose frames are published on a timer.
 *
 * The player honours the main process' sequencing rules — per-turn contiguous
 * numbers, `conversation.started` unnumbered, one terminal event — and retains
 * the authoritative snapshot after every frame, so `transcriptSnapshot()`
 * answers with the real main-side prefix and the gap/re-sync path works for
 * real in the browser.
 */
export function createFakeBridge(options: FakeBridgeOptions): FakeBridge {
  const context = options.context ?? createFixtureContext()
  const initial = options.initial ?? createHarnessInitialState(options.scenario, context)
  const origin = options.origin

  let delayMs = Math.max(0, options.delayMs ?? options.scenario.delayMs ?? DEFAULT_FRAME_DELAY_MS)
  let settings = makeSettings()
  let runtime: RuntimeStatus = {
    state: 'ready',
    authMode: 'chatgpt-local',
    detail: 'Harness fake bridge — no Codex process is running.',
  }

  const models = makeModelOptions([
    { id: 'codex-default', displayName: 'Codex (default)', isDefault: true },
    { id: 'codex-mini', displayName: 'Codex mini' },
  ])

  const sessions = new Map<string, SessionDetail>(
    initial.sessions.map((session) => [session.id, session]),
  )
  const workspaces = new Map<string, Workspace>(
    initial.workspaces.map((workspace) => [workspace.id, workspace]),
  )
  let selectedWorkspaceId: string | null = initial.workspaces[0]?.id ?? null
  let activeSessionId: string | null = initial.sessions[0]?.id ?? null
  let attachments: HarnessAttachment[] = [...initial.attachments]

  const eventLog: ProductEvent[] = []
  const productListeners = new Set<(event: ProductEvent) => void>()
  const subscriptionListeners = new Map<string, DesktopSubscriptionListener>()
  const turns = new Map<string, ActiveTurn>()
  const retained = new Map<string, TranscriptSnapshot>()
  let listenersAttached: (() => void) | undefined
  let listenerHandoff: ReturnType<typeof setTimeout> | undefined
  let lastOverlaySize: { width: number; height: number } | null = null
  let overlayFocusable = true
  let disposed = false
  let paused = false

  const publish = (event: ProductEvent): void => {
    eventLog.push(event)
    if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG)
    for (const listener of [...productListeners]) listener(event)
  }

  const retain = (snapshot: TranscriptSnapshot): void => {
    retained.set(snapshot.turnId, snapshot)
    while (retained.size > MAX_RETAINED_SNAPSHOTS) {
      const oldest = retained.keys().next()
      if (oldest.done) break
      retained.delete(oldest.value)
    }
  }

  const touchSession = (sessionId: string, mutate: (session: SessionDetail) => void): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    mutate(session)
    session.messageCount = session.messages.length
    session.updatedAt = context.nextTimestamp()
  }

  const NEW_SESSION_TITLE = 'New session'

  const appendSessionMessage = (
    sessionId: string,
    role: SessionDetail['messages'][number]['role'],
    content: string,
    attachmentIds: string[] = [],
  ): void => {
    touchSession(sessionId, (session) => {
      session.messages.push({
        id: context.nextId('message'),
        role,
        content,
        attachmentIds,
        createdAt: context.nextTimestamp(),
      })
      if (session.title === NEW_SESSION_TITLE && role === 'user') {
        session.title = content.slice(0, 60)
      }
    })
  }

  const createSessionRecord = (): SessionDetail => {
    const id = context.nextId('session')
    const now = context.nextTimestamp()
    const session: SessionDetail = {
      id,
      title: NEW_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
      terminalState: 'active',
      messageCount: 0,
      workspaceId: selectedWorkspaceId,
      messages: [],
      toolEvents: [],
    }
    sessions.set(id, session)
    activeSessionId = id
    return session
  }

  const ensureSession = (sessionId?: string): SessionDetail => {
    if (sessionId) {
      const existing = sessions.get(sessionId)
      if (existing) {
        activeSessionId = existing.id
        return existing
      }
    }
    const active = activeSessionId ? sessions.get(activeSessionId) : undefined
    return active ?? createSessionRecord()
  }

  const finishTurn = (turn: ActiveTurn): void => {
    turn.finished = true
    turn.timer = undefined
    const answer = turn.snapshot.answer
    if (answer.trim()) {
      appendSessionMessage(turn.recording.sessionId, 'assistant', answer)
      publish({ type: 'sessions.changed' })
    }
  }

  const advance = (turnId: string): void => {
    const turn = turns.get(turnId)
    if (!turn || turn.finished || disposed) return
    // The scheduled handle has fired (or we are stepping); resume() relies on
    // an undefined timer to know this turn needs rescheduling.
    turn.timer = undefined
    const frame = turn.recording.frames[turn.index]
    if (!frame) {
      finishTurn(turn)
      return
    }
    turn.index += 1
    turn.snapshot = frame.snapshot
    retain(frame.snapshot)
    for (const event of frame.events) publish(event)
    if (!frame.snapshot.live) {
      finishTurn(turn)
      return
    }
    if (turn.pauseBudget !== undefined) {
      turn.pauseBudget -= 1
      if (turn.pauseBudget <= 0) {
        turn.pauseBudget = undefined
        paused = true
      }
    }
    if (!paused) turn.timer = setTimeout(() => advance(turnId), delayMs)
  }

  const startTurn = (input: {
    sessionId?: string
    recipe?: TurnRecipeName
    consumedAttachmentIds?: readonly string[]
    pauseAfter?: number
  }): ConversationTurnResult => {
    const session = ensureSession(input.sessionId)
    const recipe = input.recipe ?? options.scenario.recipe
    const consumedAttachmentIds = [...(input.consumedAttachmentIds ?? [])]
    const recording = recordRecipe(recipe, {
      sessionId: session.id,
      turnId: context.nextId('turn'),
      origin,
      consumedAttachmentIds,
      context,
    })
    const pauseAfter = input.pauseAfter ?? options.pauseAfter
    const turn: ActiveTurn = {
      recording,
      recipe,
      index: 0,
      snapshot: recording.initialSnapshot,
      timer: undefined,
      finished: false,
      pauseBudget: pauseAfter !== undefined && pauseAfter > 0 ? pauseAfter : undefined,
    }
    if (pauseAfter !== undefined && pauseAfter <= 0) paused = true
    turns.set(recording.turnId, turn)
    retain(recording.initialSnapshot)
    // The main process announces before the command response resolves, which is
    // what exercises the renderer's pre-announcement deferral.
    publish(recording.started)
    if (!paused) turn.timer = setTimeout(() => advance(recording.turnId), delayMs)
    return {
      sessionId: recording.sessionId,
      turnId: recording.turnId,
      consumedAttachmentIds,
    }
  }

  const consumeAttachments = (ids: readonly string[]): string[] => {
    const consumed = ids.filter((id) => attachments.some((attachment) => attachment.id === id))
    attachments = attachments.filter((attachment) => !consumed.includes(attachment.id))
    return consumed
  }

  const captureAttachment = (): HarnessAttachment => {
    const attachment = makeHarnessAttachment(context)
    if (attachments.length < MAX_QUEUED_ATTACHMENTS) attachments = [...attachments, attachment]
    publish({ type: 'attachment.captured', attachment })
    return attachment
  }

  const noteListener = (): void => {
    if (!listenersAttached || listenerHandoff !== undefined) return
    // Deferred one tick so every consumer mounted in the same commit (settings,
    // the store bridge, the page) is attached before the first event lands.
    listenerHandoff = setTimeout(() => {
      listenerHandoff = undefined
      const callback = listenersAttached
      listenersAttached = undefined
      callback?.()
    }, 0)
  }

  const bridge: FakeBridge = {
    marker: HARNESS_MARKER,

    get events() {
      return eventLog as readonly ProductEvent[]
    },

    emitScript(recipe, scriptOptions) {
      return startTurn({ recipe, pauseAfter: scriptOptions?.pauseAfter })
    },

    emit(event) {
      publish(ProductEventSchema.parse(event))
    },

    emitOverlayOpened(overlayOptions = {}) {
      publish({
        type: 'overlay.opened',
        fresh: overlayOptions.fresh ?? true,
        sessionId:
          overlayOptions.sessionId === undefined
            ? activeSessionId
            : overlayOptions.sessionId,
      })
    },

    emitSubscription(event) {
      const parsed = SubscriptionEventSchema.parse(event)
      for (const listener of [...subscriptionListeners.values()]) listener(parsed)
    },

    setDelay(next) {
      delayMs = Math.max(0, next)
    },

    pause() {
      paused = true
      for (const turn of turns.values()) {
        if (turn.timer !== undefined) {
          clearTimeout(turn.timer)
          turn.timer = undefined
        }
      }
    },

    resume() {
      if (!paused || disposed) return
      paused = false
      for (const [turnId, turn] of turns) {
        if (!turn.finished && turn.timer === undefined) {
          turn.timer = setTimeout(() => advance(turnId), delayMs)
        }
      }
    },

    step(count = 1) {
      bridge.pause()
      for (let published = 0; published < count; published += 1) {
        for (const [turnId, turn] of turns) {
          if (!turn.finished) advance(turnId)
        }
      }
    },

    whenListenersAttach(callback) {
      listenersAttached = callback
      if (productListeners.size > 0) noteListener()
    },

    clearEvents() {
      eventLog.length = 0
    },

    state() {
      return {
        scenario: options.scenario.name,
        origin,
        delayMs,
        paused,
        settings,
        sessions: [...sessions.values()].map(summarizeHarnessSession),
        activeSessionId,
        workspaces: [...workspaces.values()],
        selectedWorkspaceId,
        attachments: [...attachments],
        runtime,
        turns: [...turns.values()].map((turn) => ({
          turnId: turn.recording.turnId,
          sessionId: turn.recording.sessionId,
          sequence: turn.snapshot.sequence,
          live: !turn.finished,
          recipe: turn.recipe,
        })),
        productListeners: productListeners.size,
        lastOverlaySize,
        overlayFocusable,
      }
    },

    dispose() {
      disposed = true
      for (const turn of turns.values()) {
        if (turn.timer !== undefined) clearTimeout(turn.timer)
        turn.timer = undefined
      }
      if (listenerHandoff !== undefined) clearTimeout(listenerHandoff)
      listenerHandoff = undefined
      listenersAttached = undefined
      productListeners.clear()
      subscriptionListeners.clear()
    },

    // --- bridge surface -------------------------------------------------------

    async bootstrap() {
      return makeBootstrap({ settings }, createFixtureContext())
    },

    async snapshot() {
      return makeBootstrap({ settings }, createFixtureContext())
    },

    async subscribe(topics, listener): Promise<DesktopSubscriptionCleanup> {
      if (topics.length === 0) throw new Error('subscribe requires at least one topic')
      const id = context.nextId('subscription')
      subscriptionListeners.set(id, listener)
      return async () => {
        subscriptionListeners.delete(id)
      }
    },

    async runtimeStatus() {
      return runtime
    },

    async testConnection() {
      return makeConnectionTestResult({ success: true })
    },

    async listModels() {
      return models
    },

    async useChatGpt() {
      runtime = { ...runtime, state: 'ready', authMode: 'chatgpt-local' }
      publish({ type: 'runtime.status', status: runtime })
      return runtime
    },

    async setApiKey(apiKey) {
      if (!apiKey.trim()) throw new Error('The API key must not be empty.')
      runtime = { ...runtime, state: 'ready', authMode: 'api-key' }
      publish({ type: 'runtime.status', status: runtime })
      return runtime
    },

    async getSettings() {
      return settings
    },

    async updateSettings(next) {
      settings = CanonicalSettingsSchema.parse(next)
      publish({ type: 'settings.changed', settings })
      return settings
    },

    async listSessions() {
      return [...sessions.values()]
        .map(summarizeHarnessSession)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    },

    async getSession(sessionId) {
      const session = sessions.get(sessionId)
      return session ? cloneSession(session) : null
    },

    async createSession() {
      const session = createSessionRecord()
      publish({ type: 'sessions.changed' })
      return cloneSession(session)
    },

    async deleteSession(sessionId) {
      const removed = sessions.delete(sessionId)
      if (!removed) return false
      if (activeSessionId === sessionId) {
        activeSessionId = sessions.keys().next().value ?? null
      }
      publish({ type: 'sessions.changed' })
      return true
    },

    async reactivateSession(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`Unknown session '${sessionId}'.`)
      activeSessionId = sessionId
      session.terminalState = 'active'
      publish({ type: 'sessions.changed' })
      return cloneSession(session)
    },

    async listWorkspaces() {
      return [...workspaces.values()]
    },

    async pickWorkspace() {
      const workspace = makeHarnessWorkspaceRecord(context, workspaces.size + 1)
      workspaces.set(workspace.id, workspace)
      selectedWorkspaceId = workspace.id
      return workspace
    },

    async selectWorkspace(workspaceId) {
      const workspace = workspaces.get(workspaceId)
      if (!workspace) throw new Error(`Unknown workspace '${workspaceId}'.`)
      selectedWorkspaceId = workspaceId
      return workspace
    },

    async removeWorkspace(workspaceId) {
      const removed = workspaces.delete(workspaceId)
      if (removed && selectedWorkspaceId === workspaceId) {
        selectedWorkspaceId = workspaces.keys().next().value ?? null
      }
      return removed
    },

    async sendMessage(input) {
      const session = ensureSession(input.sessionId)
      const consumed = consumeAttachments(input.attachmentIds)
      appendSessionMessage(session.id, 'user', input.message, consumed)
      return startTurn({ sessionId: session.id, consumedAttachmentIds: consumed })
    },

    async solvePending() {
      const session = ensureSession()
      const consumed = consumeAttachments(attachments.map((attachment) => attachment.id))
      appendSessionMessage(session.id, 'user', 'Solve the queued screenshots.', consumed)
      return startTurn({ sessionId: session.id, consumedAttachmentIds: consumed })
    },

    async stopTurn(turnId) {
      const turn = turns.get(turnId)
      if (!turn || turn.finished) return false
      if (turn.timer !== undefined) clearTimeout(turn.timer)
      turn.timer = undefined
      // Same terminal presentation the main process derives for an interrupted
      // turn, and the same contiguous sequence it would have claimed next.
      const sequence = turn.snapshot.sequence + 1
      const streamed = turn.snapshot.answer.trim().length > 0
      turn.snapshot = { ...turn.snapshot, sequence, live: false }
      retain(turn.snapshot)
      publish(
        streamed
          ? {
              type: 'transcript.complete',
              sessionId: turn.recording.sessionId,
              turnId,
              origin,
              sequence,
            }
          : {
              type: 'transcript.failed',
              sessionId: turn.recording.sessionId,
              turnId,
              origin,
              sequence,
              message: STOPPED_WITHOUT_ANSWER,
            },
      )
      finishTurn(turn)
      return true
    },

    async transcriptSnapshot(turnId) {
      return retained.get(turnId) ?? null
    },

    async capture() {
      return captureAttachment()
    },

    async captureSelection() {
      return captureAttachment()
    },

    async listAttachments() {
      return [...attachments]
    },

    async getAttachmentPreviews(attachmentIds) {
      return attachments.filter((attachment) => attachmentIds.includes(attachment.id))
    },

    async discardAttachment(attachmentId) {
      const before = attachments.length
      attachments = attachments.filter((attachment) => attachment.id !== attachmentId)
      return attachments.length < before
    },

    async clearAttachments() {
      attachments = []
      publish({ type: 'attachments.cleared' })
    },

    async openHome() {
      // The harness renders one role per page; there is no second window to show.
    },

    async toggleOverlay() {
      // Visibility is the shell's business. Use `emitOverlayOpened()` to drive
      // the overlay's re-open behaviour explicitly.
    },

    async resizeOverlay(width, height) {
      lastOverlaySize = { width, height }
    },

    async setOverlayFocusable(focusable) {
      overlayFocusable = focusable
    },

    onProductEvent(listener) {
      productListeners.add(listener)
      noteListener()
      return () => productListeners.delete(listener)
    },
  }

  return bridge
}

function makeHarnessWorkspaceRecord(context: FixtureContext, index: number): Workspace {
  const id = context.nextId('workspace')
  return {
    id,
    title: `picked-workspace-${index}`,
    canonicalPath: `/Users/harness/picked/${id}`,
    createdAt: context.nextTimestamp(),
    updatedAt: context.nextTimestamp(),
  }
}

/** Hands out a copy, so a consumer mutating a session detail cannot corrupt the fake. */
function cloneSession(session: SessionDetail): SessionDetail {
  return {
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      attachmentIds: [...message.attachmentIds],
    })),
    toolEvents: session.toolEvents.map((event) => ({ ...event })),
  }
}
