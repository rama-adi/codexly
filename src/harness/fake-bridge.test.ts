import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionDetail, SessionSummary } from '../renderer/desktop'
import { ProductEventSchema, type ProductEvent } from '../shared/ipc/product'
import { createFakeBridge, type FakeBridge } from './fake-bridge'
import { resolveHarnessRequest } from './install'
import {
  HARNESS_SCENARIOS,
  HARNESS_SCENARIO_NAMES,
  type HarnessAttachment,
  createHarnessInitialState,
  resolveHarnessScenario,
} from './scenarios'
import { TURN_RECIPE_NAMES, recordRecipe, recordTurn } from './turn-recipes'

/**
 * The method names declared by `CodexlyDesktopBridgeV1`, read from the contract
 * source. A method added to the bridge fails this test until the fake implements
 * it, which is the only way to keep "implements EVERY method" true over time.
 */
function declaredBridgeMethods(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../types/desktop-bridge.ts', import.meta.url)),
    'utf8',
  )
  const start = source.indexOf('export interface CodexlyDesktopBridgeV1 {')
  const end = source.indexOf('\n}', start)
  const body = source.slice(start, end)
  const names = new Set<string>()
  for (const line of body.split('\n')) {
    const match = /^ {2}(\w+)\s*\(/.exec(line)
    if (match?.[1]) names.add(match[1])
  }
  return [...names]
}

function createBridge(
  scenario: keyof typeof HARNESS_SCENARIOS = 'streaming',
  delayMs = 10,
): FakeBridge {
  return createFakeBridge({ scenario: HARNESS_SCENARIOS[scenario], origin: 'overlay', delayMs })
}

// The bridge contract types these as `unknown` (they are shaped by the main
// process, not by a shared schema), so the fake's own shapes are asserted here.
const listSessions = (fake: FakeBridge): Promise<SessionSummary[]> =>
  fake.listSessions() as Promise<SessionSummary[]>

const getSession = (fake: FakeBridge, sessionId: string): Promise<SessionDetail | null> =>
  fake.getSession(sessionId) as Promise<SessionDetail | null>

const turnScoped = (events: readonly ProductEvent[], turnId: string): ProductEvent[] =>
  events.filter((event) => 'turnId' in event && event.turnId === turnId)

const sequences = (events: readonly ProductEvent[]): number[] =>
  events.flatMap((event) => ('sequence' in event && event.sequence !== undefined ? [event.sequence] : []))

let bridge: FakeBridge

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  bridge?.dispose()
  vi.useRealTimers()
})

describe('fake bridge contract coverage', () => {
  it('implements every method the bridge contract declares', () => {
    bridge = createBridge()
    const declared = declaredBridgeMethods()

    expect(declared.length).toBeGreaterThan(30)
    for (const method of declared) {
      expect(typeof (bridge as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('publishes only events the product contract accepts', async () => {
    bridge = createBridge('toolUse', 0)
    bridge.emitScript()
    await vi.runAllTimersAsync()

    expect(bridge.events.length).toBeGreaterThan(4)
    for (const event of bridge.events) expect(() => ProductEventSchema.parse(event)).not.toThrow()
  })

  it('delivers subscription events until the subscription is released', async () => {
    bridge = createBridge()
    const received: string[] = []
    const release = await bridge.subscribe(['settings'], (event) => received.push(event.type))

    bridge.emitSubscription({ type: 'settings.changed', settings: await bridge.getSettings() })
    await release()
    bridge.emitSubscription({ type: 'settings.changed', settings: await bridge.getSettings() })

    expect(received).toEqual(['settings.changed'])
  })

  it('rejects an imperative emit that breaks the contract', () => {
    bridge = createBridge()

    expect(() => bridge.emit({ type: 'nonsense' } as unknown as ProductEvent)).toThrow()
  })
})

describe('scripted turn player', () => {
  it('stamps contiguous per-turn sequences and leaves the announcement unnumbered', async () => {
    bridge = createBridge('toolUse', 0)
    const { turnId } = bridge.emitScript()
    await vi.runAllTimersAsync()

    const events = turnScoped(bridge.events, turnId)
    const started = events[0]
    expect(started?.type).toBe('conversation.started')
    expect(started && 'sequence' in started).toBe(false)
    expect(sequences(events)).toEqual(
      Array.from({ length: sequences(events).length }, (_unused, index) => index + 1),
    )
    expect(events[events.length - 1]?.type).toBe('transcript.complete')
  })

  it('serves the authoritative prefix — including dropped content — during a gap', async () => {
    bridge = createBridge('resyncGap', 0)
    const { turnId } = bridge.emitScript('gapAndResync')

    let atGap: unknown = null
    bridge.onProductEvent((event) => {
      if (event.type !== 'transcript.gap') return
      void bridge.transcriptSnapshot(event.turnId).then((snapshot) => {
        atGap = snapshot
      })
    })
    await vi.runAllTimersAsync()

    const gap = bridge.events.find((event) => event.type === 'transcript.gap')
    expect(gap).toBeDefined()
    const snapshotAtGap = atGap as { answer: string; sequence: number } | null
    expect(snapshotAtGap?.answer).toContain('This middle part was dropped by the transport.')

    const streamedAnswer = bridge.events
      .filter((event) => event.type === 'transcript.delta')
      .map((event) => (event.type === 'transcript.delta' ? event.text : ''))
      .join('')
    expect(streamedAnswer).not.toContain('This middle part was dropped by the transport.')

    const final = await bridge.transcriptSnapshot(turnId)
    expect(final?.live).toBe(false)
    expect(final?.answer).toBe(recordRecipe('gapAndResync').frames.at(-1)?.snapshot.answer)
  })

  it('refuses a recipe that never reaches a terminal event', () => {
    // The player has nothing to publish for a still-live final frame, which
    // would strand the renderer's turn machine in `active`.
    expect(() => recordTurn([(builder) => builder.delta('no terminal')])).toThrow(
      /never reached a terminal event/,
    )
    for (const name of TURN_RECIPE_NAMES) {
      expect(recordRecipe(name).frames.at(-1)?.snapshot.live).toBe(false)
    }
  })

  it('answers with null for a turn it never played', async () => {
    bridge = createBridge()

    await expect(bridge.transcriptSnapshot('turn-unknown')).resolves.toBeNull()
  })
})

describe('stopping a turn', () => {
  it('completes an interrupted turn that already streamed text, claiming the next sequence', async () => {
    bridge = createBridge('longAnswer', 10)
    const { turnId } = bridge.emitScript('longAnswer')
    await vi.advanceTimersByTimeAsync(35)

    const before = await bridge.transcriptSnapshot(turnId)
    expect(before?.answer.length).toBeGreaterThan(0)
    await expect(bridge.stopTurn(turnId)).resolves.toBe(true)

    const terminal = bridge.events.find((event) => event.type === 'transcript.complete')
    expect(terminal).toMatchObject({ turnId, sequence: (before?.sequence ?? 0) + 1 })
    await expect(bridge.stopTurn(turnId)).resolves.toBe(false)

    // No further frames may arrive once the turn was stopped.
    const settled = bridge.events.length
    await vi.runAllTimersAsync()
    expect(bridge.events.length).toBe(settled)
  })

  it('fails an interrupted turn that streamed nothing', async () => {
    bridge = createBridge('longAnswer', 50)
    const { turnId } = bridge.emitScript('longAnswer')

    await expect(bridge.stopTurn(turnId)).resolves.toBe(true)
    const terminal = bridge.events[bridge.events.length - 1]
    expect(terminal).toMatchObject({
      type: 'transcript.failed',
      turnId,
      sequence: 1,
      message: 'Response stopped before an answer was returned.',
    })
  })
})

describe('in-memory product state', () => {
  it('persists settings and broadcasts the change', async () => {
    bridge = createBridge()
    const settings = await bridge.getSettings()

    const updated = await bridge.updateSettings({
      ...settings,
      appearance: { ...settings.appearance, answerHeight: 420 },
    })

    expect(updated.appearance.answerHeight).toBe(420)
    await expect(bridge.getSettings()).resolves.toMatchObject({
      appearance: { answerHeight: 420 },
    })
    expect(bridge.events.at(-1)).toMatchObject({ type: 'settings.changed' })
  })

  it('records both sides of a turn on the session and refreshes the list', async () => {
    bridge = createBridge('streaming', 0)
    const before = await listSessions(bridge)

    const result = await bridge.sendMessage({
      sessionId: before[0]?.id,
      message: 'Does the harness persist this?',
      modelId: 'codex-default',
      attachmentIds: [],
    })
    await vi.runAllTimersAsync()

    const session = await getSession(bridge, result.sessionId)
    const roles = session?.messages.map((message) => message.role) ?? []
    expect(roles.slice(-2)).toEqual(['user', 'assistant'])
    expect(session?.messages.at(-1)?.content).toContain('compiles cleanly')
    expect(bridge.events.some((event) => event.type === 'sessions.changed')).toBe(true)
    expect(await listSessions(bridge)).toHaveLength(before.length)
  })

  it('creates, reactivates and deletes sessions', async () => {
    bridge = createBridge('sessions', 0)
    const created = (await bridge.createSession()) as SessionDetail
    expect(created.messageCount).toBe(0)

    const reactivated = (await bridge.reactivateSession(created.id)) as SessionDetail
    expect(reactivated.terminalState).toBe('active')

    await expect(bridge.deleteSession(created.id)).resolves.toBe(true)
    await expect(bridge.deleteSession(created.id)).resolves.toBe(false)
    await expect(bridge.getSession(created.id)).resolves.toBeNull()
  })

  it('consumes the queued screenshots when solving and re-queues on capture', async () => {
    bridge = createBridge('attachments', 0)
    const queued = (await bridge.listAttachments()) as HarnessAttachment[]
    expect(queued).toHaveLength(3)
    expect(queued[0]?.preview.startsWith('data:image/png;base64,')).toBe(true)

    const result = await bridge.solvePending('codex-default')
    expect(result.consumedAttachmentIds).toHaveLength(3)
    await expect(bridge.listAttachments()).resolves.toEqual([])
    expect(bridge.events[0]).toMatchObject({
      type: 'conversation.started',
      consumedAttachmentIds: result.consumedAttachmentIds,
    })

    await bridge.capture()
    await expect(bridge.listAttachments()).resolves.toHaveLength(1)
    expect(bridge.events.at(-1)).toMatchObject({ type: 'attachment.captured' })

    await bridge.clearAttachments()
    await expect(bridge.listAttachments()).resolves.toEqual([])
    expect(bridge.events.at(-1)).toMatchObject({ type: 'attachments.cleared' })
  })

  it('reports its own state, including live turns', async () => {
    bridge = createBridge('longAnswer', 20)
    const { turnId } = bridge.emitScript('longAnswer')
    await vi.advanceTimersByTimeAsync(45)

    const state = bridge.state()
    expect(state.scenario).toBe('longAnswer')
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]).toMatchObject({ turnId, live: true, recipe: 'longAnswer' })
    expect(state.turns[0]?.sequence).toBeGreaterThan(0)
  })
})

describe('scenario registry', () => {
  it('exposes a scenario per documented name and falls back safely', () => {
    expect(HARNESS_SCENARIO_NAMES).toEqual([
      'empty',
      'streaming',
      'longAnswer',
      'reasoningHeavy',
      'toolUse',
      'error',
      'stopMidStream',
      'attachments',
      'resyncGap',
      'sessions',
    ])
    expect(resolveHarnessScenario('streaming')).toBe('streaming')
    expect(resolveHarnessScenario('nope')).toBe('empty')
    expect(resolveHarnessScenario(null)).toBe('empty')
  })

  it('references a real recipe from every scenario', () => {
    for (const name of HARNESS_SCENARIO_NAMES) {
      expect(TURN_RECIPE_NAMES).toContain(HARNESS_SCENARIOS[name].recipe)
    }
  })

  it('seeds the fixture state each scenario declares', () => {
    for (const name of HARNESS_SCENARIO_NAMES) {
      const scenario = HARNESS_SCENARIOS[name]
      const state = createHarnessInitialState(scenario)
      expect(state.sessions).toHaveLength(scenario.sessionCount)
      expect(state.attachments).toHaveLength(scenario.attachmentCount)
      expect(state.workspaces).toHaveLength(1)
      for (const session of state.sessions) expect(session.messageCount).toBe(session.messages.length)
    }
  })
})

describe('harness request resolution', () => {
  it('installs only for a harness or scenario page', () => {
    expect(resolveHarnessRequest('')).toBeNull()
    expect(resolveHarnessRequest('?role=overlay')).toBeNull()
    expect(resolveHarnessRequest('?harness=off&scenario=streaming')).toBeNull()
    expect(resolveHarnessRequest('?harness=1')).toEqual({
      role: 'homepage',
      scenario: 'empty',
      delayMs: 30,
    })
  })

  it('reads the role, scenario and delay from the query', () => {
    expect(resolveHarnessRequest('?role=overlay&scenario=toolUse')).toEqual({
      role: 'overlay',
      scenario: 'toolUse',
      delayMs: 30,
    })
    expect(resolveHarnessRequest('?scenario=longAnswer')).toMatchObject({ delayMs: 60 })
    expect(resolveHarnessRequest('?scenario=longAnswer&delay=0')).toMatchObject({ delayMs: 0 })
    expect(resolveHarnessRequest('?scenario=longAnswer&delay=999999')).toMatchObject({
      delayMs: 5_000,
    })
    expect(resolveHarnessRequest('?scenario=<script>')).toMatchObject({ scenario: 'empty' })
  })
})

describe('player freeze controls', () => {
  it('pauseAfter freezes the player mid-stream and resume() finishes the turn', async () => {
    bridge = createBridge('longAnswer', 0)
    const { turnId } = bridge.emitScript(undefined, { pauseAfter: 2 })
    await vi.runAllTimersAsync()

    const frozenCount = turnScoped(bridge.events, turnId).length
    expect(bridge.state().paused).toBe(true)
    expect(bridge.state().turns.find((turn) => turn.turnId === turnId)?.live).toBe(true)
    // started + 2 frames' events; nothing further while frozen.
    expect(frozenCount).toBeGreaterThanOrEqual(3)
    await vi.runAllTimersAsync()
    expect(turnScoped(bridge.events, turnId)).toHaveLength(frozenCount)

    bridge.resume()
    await vi.runAllTimersAsync()
    expect(bridge.state().paused).toBe(false)
    expect(bridge.state().turns.find((turn) => turn.turnId === turnId)?.live).toBe(false)
    expect(sequences(turnScoped(bridge.events, turnId))).toEqual(
      Array.from({ length: sequences(turnScoped(bridge.events, turnId)).length }, (_, i) => i + 1),
    )
  })

  it('pauseAfter: 0 freezes right after the announcement, before the first frame', async () => {
    bridge = createBridge('streaming', 0)
    const { turnId } = bridge.emitScript(undefined, { pauseAfter: 0 })
    await vi.runAllTimersAsync()

    const events = turnScoped(bridge.events, turnId)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('conversation.started')
    expect(bridge.state().paused).toBe(true)
  })

  it('step() publishes exactly one frame per call and stays paused', async () => {
    bridge = createBridge('longAnswer', 0)
    const { turnId } = bridge.emitScript(undefined, { pauseAfter: 0 })
    await vi.runAllTimersAsync()
    const baseline = turnScoped(bridge.events, turnId).length

    bridge.step()
    const afterOne = turnScoped(bridge.events, turnId).length
    expect(afterOne).toBeGreaterThan(baseline)
    expect(bridge.state().paused).toBe(true)
    await vi.runAllTimersAsync()
    expect(turnScoped(bridge.events, turnId)).toHaveLength(afterOne)

    bridge.step(2)
    expect(turnScoped(bridge.events, turnId).length).toBeGreaterThan(afterOne)
    expect(bridge.state().paused).toBe(true)
  })

  it('pause() freezes a free-running turn; a paused turn still honours stopTurn', async () => {
    bridge = createBridge('longAnswer', 10)
    const { turnId } = bridge.emitScript()
    await vi.advanceTimersByTimeAsync(25)

    bridge.pause()
    const frozen = turnScoped(bridge.events, turnId).length
    await vi.advanceTimersByTimeAsync(500)
    expect(turnScoped(bridge.events, turnId)).toHaveLength(frozen)

    await expect(bridge.stopTurn(turnId)).resolves.toBe(true)
    const terminal = turnScoped(bridge.events, turnId).at(-1)
    expect(terminal?.type).toMatch(/transcript\.(complete|failed)/)
  })

  it('?pauseAfter= is parsed into the harness request', () => {
    expect(resolveHarnessRequest('?scenario=streaming&pauseAfter=3')).toMatchObject({
      pauseAfter: 3,
    })
    expect(resolveHarnessRequest('?scenario=streaming&pauseAfter=-1')).toMatchObject({
      pauseAfter: undefined,
    })
    expect(resolveHarnessRequest('?scenario=streaming')).toMatchObject({ pauseAfter: undefined })
  })
})
