import type { CodexAppServerSession } from 'ai-sdk-provider-codex-cli'
import { describe, expect, it, vi } from 'vitest'

import { TurnController, type TurnEventEnvelope } from './turn-controller'

function setup(options: { interruptTimeoutMs?: number } = {}) {
  const events: TurnEventEnvelope[] = []
  const abortController = new AbortController()
  const threadIds: string[] = []
  const controller = new TurnController({
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    generation: 3,
    abortController,
    onEvent: (event) => {
      events.push(event)
    },
    onThreadId: (threadId) => {
      threadIds.push(threadId)
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    interruptTimeoutMs: options.interruptTimeoutMs,
  })
  return { controller, events, abortController, threadIds }
}

function fakeSession(overrides: Partial<CodexAppServerSession> = {}) {
  return {
    threadId: 'thread-1',
    turnId: 'provider-turn-1',
    injectMessage: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    isActive: () => true,
    ...overrides,
  } satisfies CodexAppServerSession
}

describe('TurnController', () => {
  it('assigns monotonic sequence numbers and persists discovered threads', async () => {
    const { controller, events, threadIds } = setup()
    await controller.start()
    await controller.accept(
      {
        type: 'raw',
        rawValue: { method: 'thread/started', params: { thread: { id: 'thr-1' } } },
      },
      3,
    )
    await controller.accept({ type: 'text-delta', id: 'a', text: 'hello' }, 3)
    await controller.completed('stop')

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(events.every((event) => event.occurredAt === '2026-01-01T00:00:00.000Z')).toBe(true)
    expect(threadIds).toEqual(['thr-1'])
    expect(events[events.length - 1]?.event).toEqual({ type: 'turn.completed', finishReason: 'stop' })
  })

  it('suppresses stale generation events', async () => {
    const { controller, events } = setup()
    await controller.start()
    await controller.accept({ type: 'text-delta', text: 'stale' }, 2)

    expect(events).toHaveLength(1)
  })

  it('uses compare-and-set so concurrent terminal paths emit exactly one terminal event', async () => {
    const { controller, events } = setup()
    await controller.start()
    await Promise.all([
      controller.completed('stop'),
      controller.failed(new Error('late failure')),
      controller.interrupted('late interrupt'),
    ])

    expect(
      events.filter((event) => event.event.type.startsWith('turn.') && event.sequence > 1),
    ).toHaveLength(1)
    expect(controller.state).toBe('completed')
  })

  it('claims interrupted state before awaiting a provider interrupt', async () => {
    const { controller, events, abortController } = setup({ interruptTimeoutMs: 5 })
    const session = fakeSession({
      interrupt: vi.fn(() => new Promise<void>(() => undefined)),
    })
    controller.attachSession(session, 3)
    await controller.start()

    const abort = controller.abort('cancelled')
    expect(controller.state).toBe('interrupted')
    expect(await controller.completed('stop')).toBe(false)
    expect(await abort).toBe(true)
    expect(abortController.signal.aborted).toBe(true)
    expect(session.interrupt).toHaveBeenCalledOnce()
    expect(events[events.length - 1]?.event).toEqual({
      type: 'turn.interrupted',
      reason: 'cancelled',
    })
  })

  it('deduplicates raw and AI SDK activity lifecycles for the same item', async () => {
    const { controller, events } = setup()
    await controller.start()
    await controller.accept(
      {
        type: 'raw',
        rawValue: {
          method: 'item/started',
          params: { item: { id: 'cmd-1', type: 'commandExecution' } },
        },
      },
      3,
    )
    await controller.accept(
      { type: 'tool-call', toolCallId: 'cmd-1', toolName: 'shell', input: {} },
      3,
    )
    await controller.accept(
      {
        type: 'raw',
        rawValue: {
          method: 'item/completed',
          params: { item: { id: 'cmd-1', type: 'commandExecution' } },
        },
      },
      3,
    )
    await controller.accept(
      { type: 'tool-result', toolCallId: 'cmd-1', toolName: 'shell', output: {} },
      3,
    )

    expect(
      events.filter((event) => event.event.type === 'activity.started'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.event.type === 'activity.completed'),
    ).toHaveLength(1)
  })

  it('ignores sessions delivered for stale runs', async () => {
    const { controller } = setup()
    const session = fakeSession()
    controller.attachSession(session, 2)
    await controller.start()
    await controller.abort()

    expect(session.interrupt).not.toHaveBeenCalled()
  })
})
