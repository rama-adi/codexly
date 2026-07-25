import { describe, expect, it, vi } from 'vitest'

import type { TurnEventEnvelope } from '../conversation/turn-controller'
import {
  decideTurnEventDisposition,
  hasActiveTurn,
  isFreshOverlayOpen,
  mergePendingAttachmentIds,
  shouldOverlayStream,
  TurnRegistry,
  type TurnRecord,
  type TurnSnapshot,
} from './turn-registry'

function snapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    turnId: 'turn-1',
    conversationId: 'session-1',
    origin: 'overlay',
    state: 'streaming',
    completionSettled: false,
    abortRequested: false,
    hasAbortHandle: true,
    draining: false,
    ...overrides,
  }
}

function envelope(turnId: string, type: 'turn.started' | 'turn.completed'): TurnEventEnvelope {
  return {
    conversationId: 'session-1',
    turnId,
    sequence: 1,
    occurredAt: new Date(0).toISOString(),
    event: { type },
  }
}

describe('TurnRegistry registration timing', () => {
  it('registers a turn synchronously, before runtime startup resolves', () => {
    const registry = new TurnRegistry()
    let record: TurnRecord | null = null

    // Models #send: the record must exist before the first await of startup.
    const started = (async () => {
      record = registry.register({
        turnId: 'turn-1',
        conversationId: 'session-1',
        origin: 'overlay',
        persistConversation: true,
      })
      await Promise.resolve()
      return 'handle'
    })()

    expect(registry.get('turn-1')?.state).toBe('initiating')
    expect(registry.hasActive('overlay')).toBe(true)
    expect(isFreshOverlayOpen(registry.snapshots(), false)).toBe(false)
    return started.then(() => {
      expect(record).not.toBeNull()
    })
  })

  it('refuses to register the same turn id twice', () => {
    const registry = new TurnRegistry()
    const input = {
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay' as const,
      persistConversation: true,
    }
    registry.register(input)
    expect(() => registry.register(input)).toThrow('already registered')
  })
})

describe('TurnRegistry abort while initiating', () => {
  it('fires the pending abort the moment the handle attaches', async () => {
    const fallbackAbort = vi.fn(async () => false)
    const registry = new TurnRegistry({ fallbackAbort })
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })

    expect(await record.requestAbort('Cleared by user')).toBe(false)
    expect(fallbackAbort).toHaveBeenCalledWith('turn-1', 'Cleared by user')
    expect(record.abortRequested).toBe(true)

    const abort = vi.fn(async () => true)
    record.attachAbort({ abort })
    await Promise.resolve()

    expect(abort).toHaveBeenCalledWith('Cleared by user')
    expect(record.abortRequested).toBe(false)
  })

  it('falls back to the runtime while no handle exists', async () => {
    const registry = new TurnRegistry({ fallbackAbort: async () => true })
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    expect(await record.requestAbort('Session reset by user')).toBe(true)
  })

  it('aborts an initiating turn through the id-free session and overlay paths', async () => {
    const fallbackAbort = vi.fn(async () => false)
    const registry = new TurnRegistry({ fallbackAbort })
    registry.register({
      turnId: 'turn-initiating',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    const streaming = registry.register({
      turnId: 'turn-streaming',
      conversationId: 'session-2',
      origin: 'homepage',
      persistConversation: true,
    })
    const abort = vi.fn(async () => true)
    streaming.attachAbort({ abort })
    streaming.markAnnounced()

    await registry.requestAbortWhere((row) => row.origin === 'overlay', 'Cleared by user')

    expect(fallbackAbort).toHaveBeenCalledWith('turn-initiating', 'Cleared by user')
    expect(abort).not.toHaveBeenCalled()
  })

  it('uses the live handle instead of the fallback once startup resolved', async () => {
    const fallbackAbort = vi.fn(async () => false)
    const registry = new TurnRegistry({ fallbackAbort })
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    const abort = vi.fn(async () => true)
    record.attachAbort({ abort })

    expect(await record.requestAbort('Stopped by user')).toBe(true)
    expect(fallbackAbort).not.toHaveBeenCalled()
  })

  it('never aborts a turn that already reached a terminal state', async () => {
    const registry = new TurnRegistry({ fallbackAbort: async () => true })
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    await record.close('turn.completed')
    expect(await record.requestAbort('Stopped by user')).toBe(false)
  })
})

describe('TurnRegistry finalization', () => {
  it('runs finalizers exactly once across every cleanup path', async () => {
    const registry = new TurnRegistry()
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    const finalizer = vi.fn()
    record.scope.defer(finalizer)

    // Send-catch, completion.finally and terminal-event finally all close.
    await Promise.all([record.close('setup failed'), record.close('completion')])
    await record.close('turn.completed')
    await registry.closeAll('disposed')

    expect(finalizer).toHaveBeenCalledOnce()
  })

  it('drops the record and its per-turn state on close', async () => {
    const registry = new TurnRegistry()
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    record.appendAssistantText('partial ')
    record.appendReasoningText('thinking')
    record.deferred.push(envelope('turn-1', 'turn.started'))

    await record.close('turn.completed')

    expect(registry.get('turn-1')).toBeUndefined()
    expect(registry.size).toBe(0)
    expect(record.state).toBe('terminal')
    expect(record.assistantText).toBe('')
    expect(record.reasoningText).toBe('')
    expect(record.deferred).toEqual([])
  })

  it('queues an event that arrives mid-drain behind the backlog, keeping publication FIFO', async () => {
    const registry = new TurnRegistry()
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    const published: string[] = []
    const queue = ['tool', 'delta-1']
    record.deferred.push(envelope('turn-1', 'turn.started'))
    record.deferred.push(envelope('turn-1', 'turn.started'))

    // Mirrors `#recordTurnEvent`: while the drain runs a live event must join the
    // queue, not be published from inside one of the drain's own awaits.
    const accept = (label: string) => {
      if (decideTurnEventDisposition(record.snapshot()) !== 'defer') {
        published.push(label)
        return
      }
      record.deferred.push(envelope('turn-1', 'turn.started'))
      queue.push(label)
    }

    record.beginDrain()
    try {
      record.markAnnounced()
      while (record.deferred.length > 0) {
        record.deferred.shift()
        const label = queue.shift()!
        if (label === 'tool') {
          // Tool envelopes persist before publishing, and the provider keeps
          // producing across that await.
          await Promise.resolve()
          accept('live-delta')
        }
        published.push(label)
      }
    } finally {
      record.endDrain()
    }

    expect(published).toEqual(['tool', 'delta-1', 'live-delta'])
  })

  it('accumulates assistant text for the terminal presentation', () => {
    const registry = new TurnRegistry()
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    record.appendAssistantText('Hello ')
    expect(record.appendAssistantText('world')).toBe('Hello world')
  })
})

describe('turn state decisions', () => {
  it('treats an initiating turn as active so the overlay does not open fresh', () => {
    const initiating = [snapshot({ state: 'initiating' })]
    expect(hasActiveTurn(initiating)).toBe(true)
    expect(isFreshOverlayOpen(initiating, false)).toBe(false)
    expect(shouldOverlayStream(initiating)).toBe(true)
  })

  it('opens fresh only when nothing is in flight and the caller did not preserve', () => {
    expect(isFreshOverlayOpen([], false)).toBe(true)
    expect(isFreshOverlayOpen([], true)).toBe(false)
    expect(isFreshOverlayOpen([snapshot({ state: 'terminal' })], false)).toBe(true)
    expect(
      isFreshOverlayOpen([snapshot({ completionSettled: true })], false),
    ).toBe(true)
  })

  it('keeps the overlay streaming flag on while a newer overlay turn is live', () => {
    const superseded = snapshot({ turnId: 'old', completionSettled: true })
    const fresh = snapshot({ turnId: 'new', state: 'announced' })
    expect(shouldOverlayStream([superseded, fresh])).toBe(true)
    expect(shouldOverlayStream([superseded])).toBe(false)
  })

  it('ignores homepage turns when deriving the overlay streaming flag', () => {
    expect(shouldOverlayStream([snapshot({ origin: 'homepage' })])).toBe(false)
    expect(hasActiveTurn([snapshot({ origin: 'homepage' })], 'homepage')).toBe(true)
  })

  it('defers before the announcement, delivers after it, and drops the unknown', () => {
    expect(decideTurnEventDisposition(snapshot({ state: 'initiating' }))).toBe('defer')
    expect(decideTurnEventDisposition(snapshot({ state: 'announced' }))).toBe('deliver')
    expect(decideTurnEventDisposition(snapshot({ state: 'streaming' }))).toBe('deliver')
    expect(decideTurnEventDisposition(snapshot({ state: 'terminal' }))).toBe('drop')
    expect(decideTurnEventDisposition(undefined)).toBe('drop')
  })

  it('keeps deferring while the announcement drains, so publication stays FIFO', () => {
    expect(
      decideTurnEventDisposition(snapshot({ state: 'announced', draining: true })),
    ).toBe('defer')
    expect(
      decideTurnEventDisposition(snapshot({ state: 'streaming', draining: true })),
    ).toBe('defer')
    // A closed record still drops: the drain cannot outlive the teardown.
    expect(
      decideTurnEventDisposition(snapshot({ state: 'terminal', draining: true })),
    ).toBe('drop')
  })

  it('advances state only forward through the lifecycle', () => {
    const registry = new TurnRegistry()
    const record = registry.register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })
    record.markStreaming()
    expect(record.state).toBe('streaming')
    record.markAnnounced()
    expect(record.state).toBe('streaming')
  })
})

describe('mergePendingAttachmentIds', () => {
  it('preserves a capture that completed while the listing was in flight', () => {
    expect(
      mergePendingAttachmentIds(['shot-1'], ['shot-1', 'shot-2'], ['shot-1']),
    ).toEqual(['shot-1', 'shot-2'])
  })

  it('drops ids that the listing no longer reports as pending', () => {
    expect(mergePendingAttachmentIds(['shot-1'], ['shot-1'], [])).toEqual([])
  })

  it('never duplicates an id the listing already returned', () => {
    expect(
      mergePendingAttachmentIds([], ['shot-2'], ['shot-1', 'shot-2']),
    ).toEqual(['shot-1', 'shot-2'])
  })
})

describe('TurnRecord transcript sequencing', () => {
  const register = () =>
    new TurnRegistry().register({
      turnId: 'turn-1',
      conversationId: 'session-1',
      origin: 'overlay',
      persistConversation: true,
    })

  it('hands out contiguous sequence numbers starting at one', () => {
    const record = register()
    expect(record.latestSequence).toBe(0)
    expect([record.nextSequence(), record.nextSequence(), record.nextSequence()]).toEqual([
      1, 2, 3,
    ])
    expect(record.latestSequence).toBe(3)
  })

  it('snapshots the accumulated transcript with the latest sequence', () => {
    const record = register()
    record.appendReasoningText('thinking ')
    record.appendAssistantText('answer ')
    record.appendAssistantText('continued')
    record.appendToolOutput('activity-1', 'first ')
    record.appendToolOutput('activity-1', 'second')
    record.appendToolOutput('activity-2', 'other')
    record.nextSequence()
    record.nextSequence()

    expect(record.transcriptSnapshot()).toEqual({
      turnId: 'turn-1',
      sessionId: 'session-1',
      origin: 'overlay',
      sequence: 2,
      answer: 'answer continued',
      reasoning: 'thinking ',
      toolOutputs: [
        { activityId: 'activity-1', text: 'first second' },
        { activityId: 'activity-2', text: 'other' },
      ],
      live: true,
    })
  })

  it('bounds retained tool output so a snapshot always satisfies its contract', () => {
    const record = register()
    for (let index = 0; index < 260; index += 1) {
      record.appendToolOutput(`activity-${index}`, 'x')
    }
    const snapshot = record.transcriptSnapshot()
    expect(snapshot.toolOutputs).toHaveLength(200)
    // The oldest activities are the ones dropped.
    expect(snapshot.toolOutputs[0]?.activityId).toBe('activity-60')

    record.appendToolOutput('activity-long', 'y'.repeat(20_000))
    const bounded = record
      .transcriptSnapshot()
      .toolOutputs.find((output) => output.activityId === 'activity-long')
    expect(bounded?.text.length).toBe(16_000)
  })

  it('reports a closed turn as no longer live', async () => {
    const record = register()
    record.appendAssistantText('done')
    const snapshot = record.transcriptSnapshot()
    await record.close('completed')
    expect(snapshot.answer).toBe('done')
    expect(record.transcriptSnapshot().live).toBe(false)
  })
})
