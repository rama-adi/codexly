import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../src/shared/ipc/operations'
import type { ProductEvent } from '../src/shared/ipc/product'
import { resetFakeRendererBridge } from './test/fake-electron'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  exposed: undefined as unknown,
  invoke: vi.fn(),
}))

vi.mock('electron', async () => {
  const { createFakeElectron } = await import('./test/fake-electron')
  return createFakeElectron(electron)
})

type ProductBridge = {
  onProductEvent(listener: (event: ProductEvent) => void): () => void
  sendMessage(input: {
    message: string
    modelId: string
    attachmentIds: string[]
  }): Promise<unknown>
  solvePending(modelId: string): Promise<unknown>
  transcriptSnapshot(turnId: string): Promise<unknown>
}

async function loadBridge(): Promise<ProductBridge> {
  await import('./preload')
  return (electron.exposed as { v1: ProductBridge }).v1
}

function emitProduct(event: unknown): void {
  electron.handlers.get(IPC_CHANNELS.productEvent)?.({}, event)
}

const started: ProductEvent = {
  type: 'conversation.started',
  sessionId: 'session-1',
  turnId: 'turn-1',
  origin: 'overlay',
  consumedAttachmentIds: ['attachment-1'],
}

beforeEach(() => {
  vi.resetModules()
  resetFakeRendererBridge(electron)
})

describe('preload product event delivery', () => {
  it('replays lifecycle, attachment, start, and instant terminal events in order', async () => {
    const bridge = await loadBridge()
    const events: ProductEvent[] = []
    emitProduct({ type: 'overlay.opened', fresh: true, sessionId: null })
    emitProduct({
      type: 'attachment.captured',
      attachment: { id: 'attachment-1' },
    })
    emitProduct(started)
    emitProduct({
      type: 'transcript.complete',
      sessionId: 'session-1',
      turnId: 'turn-1',
      origin: 'overlay',
    })

    bridge.onProductEvent((event) => events.push(event))

    expect(events.map((event) => event.type)).toEqual([
      'overlay.opened',
      'attachment.captured',
      'conversation.started',
      'transcript.complete',
    ])
  })

  it('replays the hand-off buffer to every subscriber, not just the first', async () => {
    const bridge = await loadBridge()
    emitProduct({ type: 'overlay.opened', fresh: false, sessionId: 'session-1' })
    emitProduct(started)

    // Mirrors the homepage window: a narrow consumer (settings) subscribes first
    // and used to swallow the whole buffer before the page mounted.
    const settings: ProductEvent[] = []
    bridge.onProductEvent((event) => {
      if (event.type === 'settings.changed') settings.push(event)
    })
    const page: ProductEvent[] = []
    bridge.onProductEvent((event) => page.push(event))
    const late: ProductEvent[] = []
    bridge.onProductEvent((event) => late.push(event))

    expect(settings).toEqual([])
    expect(page.map((event) => event.type)).toEqual([
      'overlay.opened',
      'conversation.started',
    ])
    expect(late.map((event) => event.type)).toEqual([
      'overlay.opened',
      'conversation.started',
    ])

    // Live events still reach every attached listener exactly once.
    emitProduct({ type: 'attachments.cleared' })
    expect(page.map((event) => event.type)).toEqual([
      'overlay.opened',
      'conversation.started',
      'attachments.cleared',
    ])
  })

  it('stops replaying once the hand-off window has closed', async () => {
    vi.useFakeTimers()
    try {
      const bridge = await loadBridge()
      emitProduct({ type: 'overlay.opened', fresh: false, sessionId: 'session-1' })
      const first: ProductEvent[] = []
      const unsubscribe = bridge.onProductEvent((event) => first.push(event))
      expect(first).toHaveLength(1)
      unsubscribe()

      vi.advanceTimersByTime(5_000)
      emitProduct({ type: 'sessions.changed' })
      const second: ProductEvent[] = []
      bridge.onProductEvent((event) => second.push(event))
      expect(second).toEqual([])

      emitProduct({ type: 'attachments.cleared' })
      expect(first).toHaveLength(1)
      expect(second.map((event) => event.type)).toEqual(['attachments.cleared'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores malformed events before and after listener attachment', async () => {
    const bridge = await loadBridge()
    emitProduct({ type: 'conversation.started', sessionId: '' })
    emitProduct(null)
    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    emitProduct({ type: 'transcript.complete', unexpected: true })
    emitProduct({ type: 'sessions.changed' })
    expect(events.map((event) => event.type)).toEqual(['sessions.changed'])
  })

  it('bounds opaque cyclic attachment metadata without serialization failure', async () => {
    const bridge = await loadBridge()
    const attachment: Record<string, unknown> = { id: 'cyclic-shot' }
    attachment['self'] = attachment
    expect(() =>
      emitProduct({ type: 'attachment.captured', attachment }),
    ).not.toThrow()
    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'attachment.captured',
      attachment: { id: 'cyclic-shot' },
    })
  })

  it('bounds a delta storm without dropping start, control, or terminal events', async () => {
    const bridge = await loadBridge()
    emitProduct({ type: 'overlay.opened', fresh: true, sessionId: null })
    emitProduct(started)
    for (let index = 0; index < 1_000; index += 1) {
      emitProduct({
        type: index % 2 === 0 ? 'transcript.delta' : 'transcript.reasoning',
        sessionId: 'session-1',
        turnId: 'turn-1',
        origin: 'overlay',
        sequence: index + 1,
        text: `chunk-${index}`,
      })
    }
    emitProduct({ type: 'attachments.cleared' })
    emitProduct({
      type: 'transcript.failed',
      sessionId: 'session-1',
      turnId: 'turn-1',
      origin: 'overlay',
      message: 'instant failure',
    })

    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    const gaps = events.filter(
      (event): event is Extract<ProductEvent, { type: 'transcript.gap' }> =>
        event.type === 'transcript.gap',
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ turnId: 'turn-1', origin: 'overlay' })
    expect(gaps[0].droppedCount).toBeGreaterThan(0)
    expect(gaps[0].evictedThrough).toBeGreaterThan(0)
    const protectedTypes = events
      .filter((event) =>
        [
          'overlay.opened',
          'conversation.started',
          'attachments.cleared',
          'transcript.failed',
        ].includes(event.type),
      )
      .map((event) => event.type)

    expect(protectedTypes).toEqual([
      'overlay.opened',
      'conversation.started',
      'attachments.cleared',
      'transcript.failed',
    ])
    expect(events.length).toBeLessThanOrEqual(128)
  })

  it('sacrifices identity-free events before turn lifecycle events at the count cap', async () => {
    const bridge = await loadBridge()
    emitProduct(started)
    for (let index = 0; index < 200; index += 1) {
      emitProduct({
        type: 'attachment.captured',
        attachment: { id: `shot-${index}` },
      })
    }
    emitProduct({
      type: 'transcript.complete',
      sessionId: 'session-1',
      turnId: 'turn-1',
      origin: 'overlay',
    })

    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    expect(events.length).toBeLessThanOrEqual(128)
    expect(events.map((event) => event.type)).toContain('conversation.started')
    expect(events.map((event) => event.type)).toContain('transcript.complete')
  })

  it('retains a full-size attachment preview with surrounding lifecycle events', async () => {
    const bridge = await loadBridge()
    const preview = `data:image/png;base64,${'A'.repeat(512 * 1024)}`
    emitProduct({ type: 'overlay.opened', fresh: true, sessionId: null })
    emitProduct({
      type: 'attachment.captured',
      attachment: { id: 'large-shot', name: 'Screenshot.png', preview },
    })
    emitProduct(started)
    emitProduct({
      type: 'transcript.complete',
      sessionId: 'session-1',
      turnId: 'turn-1',
      origin: 'overlay',
    })

    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    expect(events.map((event) => event.type)).toEqual([
      'overlay.opened',
      'attachment.captured',
      'conversation.started',
      'transcript.complete',
    ])
    expect(events[1]).toMatchObject({
      type: 'attachment.captured',
      attachment: { id: 'large-shot', preview },
    })
  })

  it('replaces stale captures for the same attachment id without reordering peers', async () => {
    const bridge = await loadBridge()
    emitProduct({ type: 'overlay.opened', fresh: true, sessionId: null })
    emitProduct({
      type: 'attachment.captured',
      attachment: { id: 'shot-1', preview: 'old' },
    })
    emitProduct(started)
    emitProduct({
      type: 'attachment.captured',
      attachment: { id: 'shot-1', preview: 'new' },
    })
    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    expect(events.map((event) => event.type)).toEqual([
      'overlay.opened',
      'conversation.started',
      'attachment.captured',
    ])
    expect(events[2]).toMatchObject({ attachment: { preview: 'new' } })
  })

  it('coalesces adjacent transcript chunks, keeping their order and newest sequence', async () => {
    const bridge = await loadBridge()
    emitProduct(started)
    ;['one', '-', 'two'].forEach((text, index) => {
      emitProduct({
        type: 'transcript.delta',
        sessionId: 'session-1',
        turnId: 'turn-1',
        origin: 'overlay',
        sequence: index + 1,
        text,
      })
    })
    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    expect(events).toHaveLength(2)
    // The merged event carries the whole run, so it claims the run's last
    // sequence: a consumer that applies it is caught up through 3.
    expect(events[1]).toMatchObject({
      type: 'transcript.delta',
      text: 'one-two',
      sequence: 3,
    })
  })

  it('marks a gap per turn without evicting the marker itself', async () => {
    const bridge = await loadBridge()
    emitProduct(started)
    const filler = 'x'.repeat(64 * 1024)
    for (let index = 0; index < 12; index += 1) {
      emitProduct({
        type: 'tool.output',
        sessionId: 'session-1',
        turnId: 'turn-1',
        origin: 'overlay',
        sequence: index + 1,
        activityId: `activity-${index}`,
        text: filler,
        preliminary: false,
      })
    }
    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    const gaps = events.filter((event) => event.type === 'transcript.gap')
    expect(gaps).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'conversation.started' })
    expect(events.indexOf(gaps[0])).toBe(1)
  })
})

describe('preload transcript snapshot validation', () => {
  it('parses the snapshot contract and accepts a null for an unknown turn', async () => {
    const bridge = await loadBridge()
    const snapshot = {
      turnId: 'turn-1',
      sessionId: 'session-1',
      origin: 'overlay',
      sequence: 7,
      answer: 'final',
      reasoning: 'thought',
      toolOutputs: [{ activityId: 'activity-1', text: 'output' }],
      live: false,
    }
    electron.invoke.mockResolvedValueOnce({ ok: true, data: snapshot })
    await expect(bridge.transcriptSnapshot('turn-1')).resolves.toEqual(snapshot)

    electron.invoke.mockResolvedValueOnce({ ok: true, data: null })
    await expect(bridge.transcriptSnapshot('turn-missing')).resolves.toBeNull()

    electron.invoke.mockResolvedValueOnce({
      ok: true,
      data: { ...snapshot, sequence: -1 },
    })
    await expect(bridge.transcriptSnapshot('turn-1')).rejects.toThrow()
  })
})

describe('preload conversation result validation', () => {
  it('accepts only the strict send/solve result contract', async () => {
    const bridge = await loadBridge()
    electron.invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        consumedAttachmentIds: ['attachment-1'],
      },
    })
    await expect(
      bridge.sendMessage({
        message: 'hello',
        modelId: 'gpt-5.5',
        attachmentIds: ['attachment-1'],
      }),
    ).resolves.toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      consumedAttachmentIds: ['attachment-1'],
    })

    electron.invoke.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: 'session-1', turnId: 'turn-1' },
    })
    await expect(bridge.solvePending('gpt-5.5')).rejects.toThrow()
  })
})
