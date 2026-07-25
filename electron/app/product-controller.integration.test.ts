import { describe, expect, it, vi } from 'vitest'

import type {
  ProductCommand,
  ProductEvent,
  TranscriptSnapshot,
} from '../../src/shared/ipc/product'
import { CredentialStore } from '../auth/credential-store'
import { MemoryJsonStore } from '../persistence/memory-json-store'
import {
  createFakeAdapters,
  FakeAttachmentStore,
  FakeConversationRuntime,
  FakeSessionStore,
  FakeSettingsStore,
  FakeWindowManager,
  FakeWorkspaceStore,
  noLegacyImport,
} from '../test/fake-main-process'
import type { Settings } from '../persistence/settings-store'
import type { WindowRole } from '../windows/window-options'
import { ProductController } from './product-controller'
import { CredentialRecordSchema } from './product-stores'

/**
 * Integration cover for the real ProductController: no `vi.mock('electron')`, no
 * filesystem, no window system. Everything the controller reaches is an injected
 * adapter, an in-memory store, or a fake runtime whose event stream the test
 * drives, so the wiring under test is the production wiring.
 */

interface Published {
  event: ProductEvent
  roles?: readonly WindowRole[]
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function createHarness(settingsOverrides: Partial<Settings> = {}) {
  const fake = createFakeAdapters()
  const settings = new FakeSettingsStore(settingsOverrides)
  const sessions = new FakeSessionStore()
  const workspaces = new FakeWorkspaceStore()
  const attachments = new FakeAttachmentStore()
  const windowManager = new FakeWindowManager()
  const published: Published[] = []
  const credentialRecord = new MemoryJsonStore({ schema: CredentialRecordSchema })
  let runtime: FakeConversationRuntime | undefined

  const controller = await ProductController.create({
    userDataPath: '/virtual/userData',
    isPackaged: false,
    resourcesPath: '/virtual/resources',
    windowManager,
    adapters: fake.adapters,
    publish: (event, roles) => {
      published.push({ event, roles })
    },
    factories: {
      settings: () => settings,
      sessions: () => sessions,
      workspaces: () => workspaces,
      attachments: () => attachments,
      credentials: ({ adapters }) =>
        new CredentialStore({
          safeStorage: adapters.safeStorage,
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
        }),
      legacyImport: () => noLegacyImport,
      runtime: ({ events }) => {
        runtime = new FakeConversationRuntime(events)
        return runtime
      },
    },
  })

  if (!runtime) throw new Error('the runtime factory was never invoked')
  return {
    controller,
    runtime,
    fake,
    settings,
    sessions,
    workspaces,
    attachments,
    windowManager,
    published,
    eventsOfType: <T extends ProductEvent['type']>(type: T) =>
      published
        .map((entry) => entry.event)
        .filter((event): event is Extract<ProductEvent, { type: T }> => event.type === type),
  }
}

const send = (): Extract<ProductCommand, { type: 'conversation.send' }> => ({
  type: 'conversation.send',
  message: 'Explain this screenshot',
  modelId: 'gpt-5.5',
  attachmentIds: [],
})

describe('ProductController composition root', () => {
  it('constructs without an Electron runtime and reports a ready runtime status', async () => {
    const electron = (await import('electron')) as Record<string, unknown>
    // Proof there is no import-time Electron access anywhere in the graph the
    // controller pulls in: this environment has no Electron runtime at all.
    expect(electron.BrowserWindow).toBeUndefined()

    const harness = await createHarness()
    expect(await harness.controller.handle({ type: 'runtime.status' }, 'homepage')).toEqual({
      state: 'ready',
      authMode: 'chatgpt-local',
      detail: 'Codex CLI is available.',
    })
    expect(harness.attachments.initialized).toBe(true)
    // Startup registers the shortcuts through the injected adapter and reports
    // the resulting state to both surfaces.
    expect(harness.fake.registeredShortcuts.size).toBe(5)
    expect(harness.eventsOfType('shortcut.status')).toHaveLength(1)
    await harness.controller.dispose()
  })

  it('still starts when the legacy import cannot even be constructed', async () => {
    const fake = createFakeAdapters()
    // A relative CODEXLY_HOME makes LegacyImporter's constructor throw. The
    // import is best-effort, so this must degrade to "no import", not brick
    // startup for every other surface.
    const controller = await ProductController.create({
      userDataPath: '/virtual/userData',
      isPackaged: false,
      resourcesPath: '/virtual/resources',
      windowManager: new FakeWindowManager(),
      adapters: {
        ...fake.adapters,
        env: {
          platform: 'linux',
          homedir: () => '/home/tester',
          readEnv: (name) => (name === 'CODEXLY_HOME' ? 'relative/home' : undefined),
        },
      },
      publish: () => undefined,
      factories: {
        settings: () => new FakeSettingsStore(),
        sessions: () => new FakeSessionStore(),
        workspaces: () => new FakeWorkspaceStore(),
        attachments: () => new FakeAttachmentStore(),
        runtime: ({ events }) => new FakeConversationRuntime(events),
      },
    })
    expect(await controller.handle({ type: 'runtime.status' }, 'homepage')).toMatchObject({
      state: 'ready',
    })
    await controller.dispose()
  })

  it('reports the construction failure instead of throwing when the runtime cannot be built', async () => {
    const fake = createFakeAdapters()
    const controller = await ProductController.create({
      userDataPath: '/virtual/userData',
      isPackaged: false,
      resourcesPath: '/virtual/resources',
      windowManager: new FakeWindowManager(),
      adapters: fake.adapters,
      publish: () => undefined,
      factories: {
        settings: () => new FakeSettingsStore(),
        sessions: () => new FakeSessionStore(),
        workspaces: () => new FakeWorkspaceStore(),
        attachments: () => new FakeAttachmentStore(),
        legacyImport: () => noLegacyImport,
        runtime: () => {
          throw new Error('codex binary is missing')
        },
      },
    })
    expect(await controller.handle({ type: 'runtime.status' }, 'homepage')).toMatchObject({
      state: 'offline',
      detail: 'codex binary is missing',
    })
    await expect(controller.handle(send(), 'overlay')).rejects.toThrow(
      'codex binary is missing',
    )
    await controller.dispose()
  })
})

describe('ProductController send-turn happy path', () => {
  it('announces the turn, then publishes contiguously sequenced transcript events', async () => {
    const harness = await createHarness()
    const result = (await harness.controller.handle(send(), 'overlay')) as {
      sessionId: string
      turnId: string
      consumedAttachmentIds: string[]
    }

    expect(result.consumedAttachmentIds).toEqual([])
    const started = harness.published.find(
      (entry) => entry.event.type === 'conversation.started',
    )
    expect(started?.roles).toEqual(['overlay'])
    expect(started?.event).toMatchObject({
      sessionId: result.sessionId,
      turnId: result.turnId,
      origin: 'overlay',
    })
    // The overlay must not hold keyboard focus while the answer streams.
    expect(harness.windowManager.calls).toContain('releaseOverlayFocus')
    expect(harness.windowManager.streaming).toBe(true)
    // The user message is persisted against the session the send created.
    const session = await harness.sessions.get(result.sessionId)
    expect(session?.messages).toMatchObject([{ role: 'user', content: send().message }])

    await harness.runtime.emit(result.turnId, { type: 'assistant.delta', text: 'Hello' })
    await harness.runtime.emit(result.turnId, { type: 'reasoning.delta', text: 'hmm' }, 2)
    await harness.runtime.emit(result.turnId, { type: 'assistant.delta', text: ' world' }, 3)
    await harness.runtime.emit(result.turnId, { type: 'turn.completed' }, 4)

    const stamped = harness.published
      .map((entry) => entry.event)
      .filter(
        (
          event,
        ): event is Extract<
          ProductEvent,
          { type: 'transcript.delta' | 'transcript.reasoning' | 'transcript.complete' }
        > =>
          event.type === 'transcript.delta' ||
          event.type === 'transcript.reasoning' ||
          event.type === 'transcript.complete',
      )
    expect(stamped.map((event) => [event.type, event.sequence])).toEqual([
      ['transcript.delta', 1],
      ['transcript.reasoning', 2],
      ['transcript.delta', 3],
      ['transcript.complete', 4],
    ])
    expect(stamped.every((event) => event.turnId === result.turnId)).toBe(true)
    // The assistant answer is persisted and the streaming affordance is released.
    const completed = await harness.sessions.get(result.sessionId)
    expect(completed?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Hello world',
    })
    expect(completed?.terminalState).toBe('completed')
    expect(harness.windowManager.streaming).toBe(false)
    expect(harness.eventsOfType('sessions.changed')).toHaveLength(1)
    await harness.controller.dispose()
  })

  it('defers events that arrive before the announcement instead of dropping them', async () => {
    const harness = await createHarness()
    const gate = deferred()
    harness.runtime.gate = gate.promise
    const sending = harness.controller.handle(send(), 'overlay')
    await vi.waitFor(() => expect(harness.runtime.started).toHaveLength(1))
    const turnId = harness.runtime.started[0]?.turnId
    if (!turnId) throw new Error('the runtime was started without a turn id')

    // Arrives while the turn is still 'initiating': it must be queued and
    // replayed after conversation.started, never published ahead of it.
    const early = harness.runtime.emit(turnId, { type: 'assistant.delta', text: 'early' })
    gate.resolve()
    await Promise.all([sending, early])

    const ordered = harness.published
      .map((entry) => entry.event.type)
      .filter((type) => type === 'conversation.started' || type === 'transcript.delta')
    expect(ordered).toEqual(['conversation.started', 'transcript.delta'])
    await harness.controller.dispose()
  })
})

describe('ProductController transcript re-sync', () => {
  it('answers a snapshot command from the live registry, then from the retained copy', async () => {
    const harness = await createHarness()
    const { turnId } = (await harness.controller.handle(send(), 'overlay')) as {
      turnId: string
    }
    await harness.runtime.emit(turnId, { type: 'assistant.delta', text: 'partial' })

    const live = (await harness.controller.handle(
      { type: 'conversation.transcriptSnapshot', turnId },
      'overlay',
    )) as TranscriptSnapshot
    expect(live).toMatchObject({
      turnId,
      origin: 'overlay',
      answer: 'partial',
      sequence: 1,
      live: true,
    })

    await harness.runtime.emit(turnId, { type: 'assistant.delta', text: '!' }, 2)
    await harness.runtime.emit(turnId, { type: 'turn.completed' }, 3)

    // The record is gone once the turn is terminal; the retained copy is what
    // lets a renderer that only noticed the gap on the terminal event re-sync.
    const retained = (await harness.controller.handle(
      { type: 'conversation.transcriptSnapshot', turnId },
      'overlay',
    )) as TranscriptSnapshot
    expect(retained).toMatchObject({ turnId, answer: 'partial!', live: false })
    expect(
      await harness.controller.handle(
        { type: 'conversation.transcriptSnapshot', turnId: 'turn-unknown' },
        'overlay',
      ),
    ).toBeNull()
    await harness.controller.dispose()
  })

  it('carries accumulated tool output in the snapshot', async () => {
    const harness = await createHarness()
    const { turnId } = (await harness.controller.handle(send(), 'overlay')) as {
      turnId: string
    }
    await harness.runtime.emit(turnId, {
      type: 'activity.output',
      activityId: 'activity-1',
      text: 'line one',
      preliminary: false,
    })
    await harness.runtime.emit(
      turnId,
      {
        type: 'activity.output',
        activityId: 'activity-1',
        text: ' line two',
        preliminary: false,
      },
      2,
    )
    const snapshot = (await harness.controller.handle(
      { type: 'conversation.transcriptSnapshot', turnId },
      'overlay',
    )) as TranscriptSnapshot
    expect(snapshot.toolOutputs).toEqual([
      { activityId: 'activity-1', text: 'line one line two' },
    ])
    await harness.controller.dispose()
  })
})

describe('ProductController stop during startup', () => {
  it('reaches a turn that is still initiating and re-fires the abort once the handle attaches', async () => {
    const harness = await createHarness()
    const gate = deferred()
    harness.runtime.gate = gate.promise
    const sending = harness.controller.handle(send(), 'overlay')
    await vi.waitFor(() => expect(harness.runtime.started).toHaveLength(1))
    const turnId = harness.runtime.started[0]?.turnId
    if (!turnId) throw new Error('the runtime was started without a turn id')

    // No handle exists yet, so the stop has to travel through the registry's
    // fallback into the runtime, which already knows the turn id.
    expect(
      await harness.controller.handle({ type: 'conversation.stop', turnId }, 'overlay'),
    ).toBe(true)
    expect(harness.runtime.abortTurnCalls).toEqual([
      { turnId, reason: 'Stopped by user' },
    ])

    gate.resolve()
    await sending
    // attachAbort replays the pending intent, so the turn is aborted through its
    // own handle as well and does not survive startup.
    await vi.waitFor(() =>
      expect(harness.runtime.turns.get(turnId)?.aborts).toEqual([
        'Stopped by user',
        'Stopped by user',
      ]),
    )
    await vi.waitFor(() => expect(harness.windowManager.streaming).toBe(false))
    await harness.controller.dispose()
  })

  it('aborts an initiating overlay turn when the overlay resets its session', async () => {
    const harness = await createHarness()
    const gate = deferred()
    harness.runtime.gate = gate.promise
    const sending = harness.controller.handle(send(), 'overlay')
    await vi.waitFor(() => expect(harness.runtime.started).toHaveLength(1))
    const turnId = harness.runtime.started[0]?.turnId
    if (!turnId) throw new Error('the runtime was started without a turn id')

    await harness.controller.handle({ type: 'sessions.create' }, 'overlay')
    expect(harness.runtime.abortTurnCalls).toEqual([
      { turnId, reason: 'Session reset by user' },
    ])
    gate.resolve()
    await sending
    await harness.controller.dispose()
  })
})

describe('ProductController openOverlay session freshness', () => {
  it('clears the active session on a plain open', async () => {
    const harness = await createHarness()
    await harness.sessions.create({ workspaceId: 'workspace-1' })
    await harness.controller.openOverlay()

    expect(harness.sessions.activeSessionId).toBeNull()
    expect(harness.windowManager.calls).toContain('showOverlay')
    expect(harness.eventsOfType('overlay.opened').at(-1)).toEqual({
      type: 'overlay.opened',
      fresh: true,
      sessionId: null,
    })
    await harness.controller.dispose()
  })

  it('pops the overlay on a fresh conversation when a workspace is selected', async () => {
    const harness = await createHarness()
    await harness.sessions.create({ workspaceId: 'workspace-1' })
    const workspaceId = harness.workspaces.workspaces[0]?.id
    if (!workspaceId) throw new Error('the harness has no workspace to select')

    await harness.controller.handle({ type: 'workspaces.select', workspaceId }, 'homepage')

    expect(harness.windowManager.calls).toContain('showOverlay')
    expect(harness.eventsOfType('overlay.opened').at(-1)).toEqual({
      type: 'overlay.opened',
      fresh: true,
      sessionId: null,
    })
    await harness.controller.dispose()
  })

  it('keeps the active session when the caller explicitly continues it', async () => {
    const harness = await createHarness()
    const session = await harness.sessions.create({ workspaceId: 'workspace-1' })
    await harness.controller.openOverlay(true)

    expect(harness.sessions.activeSessionId).toBe(session.id)
    expect(harness.eventsOfType('overlay.opened').at(-1)).toEqual({
      type: 'overlay.opened',
      fresh: false,
      sessionId: session.id,
    })
    await harness.controller.dispose()
  })

  it('is never fresh while a turn is still initiating', async () => {
    const harness = await createHarness()
    const gate = deferred()
    harness.runtime.gate = gate.promise
    const sending = harness.controller.handle(send(), 'overlay')
    await vi.waitFor(() => expect(harness.runtime.started).toHaveLength(1))
    const activeSessionId = harness.sessions.activeSessionId

    await harness.controller.openOverlay()
    // Clearing the active session under a mid-flight turn would strand it.
    expect(harness.sessions.activeSessionId).toBe(activeSessionId)
    expect(harness.eventsOfType('overlay.opened').at(-1)).toMatchObject({ fresh: false })

    gate.resolve()
    await sending
    await harness.controller.dispose()
  })
})
