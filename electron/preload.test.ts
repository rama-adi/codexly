import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS } from '../src/shared/ipc/operations'
import type { ProductEvent } from '../src/shared/ipc/product'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  exposed: undefined as unknown,
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, value: unknown) => {
      electron.exposed = value
    }),
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      electron.handlers.set(channel, listener)
    }),
  },
}))

type ProductBridge = {
  onProductEvent(listener: (event: ProductEvent) => void): () => void
  sendMessage(input: {
    message: string
    modelId: string
    attachmentIds: string[]
  }): Promise<unknown>
  solvePending(modelId: string): Promise<unknown>
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
  electron.handlers.clear()
  electron.exposed = undefined
  electron.invoke.mockReset()
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

  it('replays the initial buffer exactly once and never resurrects stale events', async () => {
    const bridge = await loadBridge()
    emitProduct({ type: 'overlay.opened', fresh: false, sessionId: 'session-1' })
    const first: ProductEvent[] = []
    const unsubscribe = bridge.onProductEvent((event) => first.push(event))
    expect(first).toHaveLength(1)

    unsubscribe()
    emitProduct({ type: 'sessions.changed' })
    const second: ProductEvent[] = []
    const unsubscribeSecond = bridge.onProductEvent((event) => second.push(event))
    expect(second).toEqual([])

    emitProduct({ type: 'attachments.cleared' })
    expect(first).toHaveLength(1)
    expect(second.map((event) => event.type)).toEqual(['attachments.cleared'])
    unsubscribeSecond()
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

  it('coalesces adjacent transcript chunks while preserving their text order', async () => {
    const bridge = await loadBridge()
    emitProduct(started)
    for (const text of ['one', '-', 'two']) {
      emitProduct({
        type: 'transcript.delta',
        sessionId: 'session-1',
        turnId: 'turn-1',
        origin: 'overlay',
        text,
      })
    }
    const events: ProductEvent[] = []
    bridge.onProductEvent((event) => events.push(event))
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'transcript.delta', text: 'one-two' })
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
