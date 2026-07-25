import { describe, expect, it, vi } from 'vitest'

import { makeTranscriptSnapshot } from '../../src/shared/fixtures/product-events'
import type { TranscriptSnapshot } from '../../src/shared/ipc/product'

import {
  announceTurnBeforeDeferredEvents,
  consumePendingAttachmentsAfter,
  consumePendingAttachmentSnapshot,
  createBoundedAttachmentPreview,
  persistTurnSetupTransaction,
  retainTranscriptSnapshot,
  persistTerminalBestEffort,
  PRODUCT_SHORTCUT_ACCELERATORS,
  restoreCapturePresentation,
  resolveTurnTerminalPresentation,
} from './product-controller'

describe('ProductController pending screenshot lifecycle', () => {
  it('consumes exactly the successful solve snapshot and preserves concurrent captures', async () => {
    const pending = ['shot-1', 'shot-2']

    const result = await consumePendingAttachmentsAfter(pending, async (snapshot) => {
      expect(snapshot).toEqual(['shot-1', 'shot-2'])
      pending.push('shot-concurrent')
      return { sessionId: 'session-1', turnId: 'turn-1' }
    })

    expect(result).toEqual({ sessionId: 'session-1', turnId: 'turn-1' })
    expect(pending).toEqual(['shot-concurrent'])
  })

  it.each(['association failed', 'runtime start failed'])(
    'preserves the snapshot for retry when %s',
    async (message) => {
      const pending = ['shot-1', 'shot-2']
      const snapshot = [...pending]

      await expect(
        consumePendingAttachmentsAfter(pending, async () => {
          throw new Error(message)
        }),
      ).rejects.toThrow(message)

      expect(pending).toEqual(snapshot)
    },
  )

  it('does not resend consumed screenshots after a later capture', () => {
    const pending = ['shot-old-1', 'shot-old-2']
    const firstSolve = [...pending]
    consumePendingAttachmentSnapshot(pending, firstSolve)
    pending.push('shot-new')

    const secondSolve = [...pending]
    expect(secondSolve).toEqual(['shot-new'])
  })

  it.each([0, 1, 2])(
    'rolls back the exact user message when atomic association batch case %i fails',
    async (failureIndex) => {
      const actions: string[] = []
      const attachmentIds = ['shot-1', 'shot-2', 'shot-3']
      await expect(
        persistTurnSetupTransaction({
          attachmentIds,
          appendMessage: async () => {
            actions.push('append-message')
          },
          associateAll: async (ids) => {
            actions.push(`associate:${ids.join(',')}`)
            throw new Error(`association failed at ${failureIndex}`)
          },
          removeMessage: async () => {
            actions.push('remove-message')
          },
        }),
      ).rejects.toThrow('association failed')

      expect(actions[actions.length - 1]).toBe('remove-message')
      expect(actions.filter((action) => action.startsWith('release:'))).toEqual([])
    },
  )

  it('does not attempt rollback writes when message persistence itself fails', async () => {
    const associateAll = vi.fn(async () => undefined)
    const removeMessage = vi.fn(async () => undefined)
    await expect(
      persistTurnSetupTransaction({
        attachmentIds: ['shot-1'],
        appendMessage: async () => {
          throw new Error('disk full')
        },
        associateAll,
        removeMessage,
      }),
    ).rejects.toThrow('disk full')
    expect(associateAll).not.toHaveBeenCalled()
    expect(removeMessage).not.toHaveBeenCalled()
  })
})

describe('ProductController global shortcut defaults', () => {
  it('uses uncommon shifted chords instead of hijacking common system shortcuts', () => {
    expect(PRODUCT_SHORTCUT_ACCELERATORS).toEqual({
      summonOverlay: 'CommandOrControl+Shift+Space',
      toggleOverlay: 'CommandOrControl+Shift+B',
      captureDisplay: 'CommandOrControl+Shift+1',
      captureSelection: 'CommandOrControl+Shift+2',
      solve: 'CommandOrControl+Shift+Enter',
    })
    expect(Object.values(PRODUCT_SHORTCUT_ACCELERATORS)).not.toContain('CommandOrControl+H')
    expect(Object.values(PRODUCT_SHORTCUT_ACCELERATORS)).not.toContain('CommandOrControl+B')
    expect(Object.values(PRODUCT_SHORTCUT_ACCELERATORS)).not.toContain('CommandOrControl+Enter')
  })
})

describe('ProductController attachment previews', () => {
  it('sends a bounded-width thumbnail over IPC instead of original screenshot bytes', () => {
    const toDataURL = vi.fn(() => 'data:image/png;base64,thumbnail')
    const resize = vi.fn(() => ({ toDataURL }))
    const createImage = vi.fn(() => ({
      getSize: () => ({ width: 1920, height: 1080 }),
      resize,
      toDataURL: vi.fn(),
    }))

    expect(createBoundedAttachmentPreview(Buffer.alloc(2_000_000), createImage as never)).toBe(
      'data:image/png;base64,thumbnail',
    )
    expect(resize).toHaveBeenCalledWith({ width: 128, height: 72, quality: 'good' })
    expect(toDataURL).toHaveBeenCalledOnce()
  })

  it('never falls back to embedding a large original when thumbnail creation fails', () => {
    expect(
      createBoundedAttachmentPreview(Buffer.alloc(200_000), () => {
        throw new Error('decode failed')
      }),
    ).toBe('')
  })
})

describe('ProductController event and focus ordering', () => {
  it('announces a turn before replaying even an already-terminal startup burst', async () => {
    const order: string[] = []
    const terminal = {
      conversationId: 'session-1',
      turnId: 'turn-1',
      sequence: 2,
      occurredAt: new Date(0).toISOString(),
      event: { type: 'turn.completed' as const },
    }
    await announceTurnBeforeDeferredEvents(
      () => order.push('conversation.started'),
      [terminal],
      async (event) => {
        order.push(event.event.type)
      },
    )
    expect(order).toEqual(['conversation.started', 'turn.completed'])
  })

  it('drains a live event appended while an older deferred event is awaiting persistence', async () => {
    const order: string[] = []
    const event = (sequence: number, type: 'turn.started' | 'turn.completed') => ({
      conversationId: 'session-1',
      turnId: 'turn-1',
      sequence,
      occurredAt: new Date(sequence).toISOString(),
      event: { type },
    })
    const queue = [event(1, 'turn.started')]
    await announceTurnBeforeDeferredEvents(
      () => order.push('conversation.started'),
      queue,
      async (envelope) => {
        order.push(envelope.event.type)
        if (envelope.sequence === 1) {
          await Promise.resolve()
          queue.push(event(2, 'turn.completed'))
        }
      },
    )
    expect(order).toEqual(['conversation.started', 'turn.started', 'turn.completed'])
  })

  it('restores visible unfocused windows without stealing external-app focus', async () => {
    const homepage = {
      setBounds: vi.fn(),
      showInactive: vi.fn(),
      focus: vi.fn(),
    }
    const overlay = {
      setBounds: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      focus: vi.fn(),
    }
    const showOverlay = vi.fn(async () => undefined)
    const state = (visible: boolean, focused: boolean) => ({
      visible,
      focused,
      clickThrough: false,
      displayId: '1',
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    })

    await restoreCapturePresentation(
      { homepage: state(true, false), overlay: state(true, false) },
      homepage as never,
      overlay as never,
      showOverlay,
    )

    expect(homepage.showInactive).toHaveBeenCalledOnce()
    expect(showOverlay).toHaveBeenCalledOnce()
    expect(homepage.focus).not.toHaveBeenCalled()
    expect(overlay.focus).not.toHaveBeenCalled()
  })

  it('restores focus only to the Codexly window that originally owned it', async () => {
    const homepage = { setBounds: vi.fn(), showInactive: vi.fn(), focus: vi.fn() }
    const overlay = {
      setBounds: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      focus: vi.fn(),
    }
    const state = (focused: boolean) => ({
      visible: true,
      focused,
      clickThrough: false,
      displayId: '1',
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    })
    await restoreCapturePresentation(
      { homepage: state(false), overlay: state(true) },
      homepage as never,
      overlay as never,
      async () => undefined,
    )
    expect(homepage.focus).not.toHaveBeenCalled()
    expect(overlay.focus).toHaveBeenCalledOnce()
  })
})

describe('ProductController terminal presentation', () => {
  it.each([0, 1, 2])(
    'publishes the terminal signal when persistence operation %i throws',
    async (failureIndex) => {
      const calls: string[] = []
      const operations = [0, 1, 2].map((index) => async () => {
        calls.push(`persist-${index}`)
        if (index === failureIndex) throw new Error('disk unavailable')
      })
      await persistTerminalBestEffort(operations, () => calls.push('transcript.complete'))
      expect(calls).toEqual(['persist-0', 'persist-1', 'persist-2', 'transcript.complete'])
    },
  )

  it.each([
    {
      event: { type: 'turn.completed' as const },
      content: '',
      state: 'failed',
      message: 'completed without returning an answer',
    },
    {
      event: { type: 'turn.interrupted' as const, reason: 'stopped' },
      content: '',
      state: 'failed',
      message: 'stopped before an answer',
    },
    {
      event: { type: 'turn.failed' as const, message: 'provider exploded' },
      content: '',
      state: 'failed',
      message: 'provider exploded',
    },
    {
      event: { type: 'turn.interrupted' as const, reason: 'stopped' },
      content: 'partial answer',
      state: 'cancelled',
      message: undefined,
    },
  ])('maps terminal ordering without an empty success: $event.type / $state', (row) => {
    const result = resolveTurnTerminalPresentation(row.event, row.content)
    expect(result.state).toBe(row.state)
    expect(result.hasAnswer).toBe(Boolean(row.content))
    if (row.message) expect(result.failureMessage).toContain(row.message)
    else expect(result.failureMessage).toBeUndefined()
  })
})

describe('ProductController retained transcript snapshots', () => {
  const snapshot = (turnId: string): TranscriptSnapshot =>
    makeTranscriptSnapshot({
      turnId,
      sessionId: 'session-1',
      sequence: 3,
      answer: `answer-${turnId}`,
    })

  it('marks a retained snapshot as no longer live', () => {
    const retained = new Map<string, TranscriptSnapshot>()
    retainTranscriptSnapshot(retained, snapshot('turn-1'))
    expect(retained.get('turn-1')).toMatchObject({ live: false, answer: 'answer-turn-1' })
  })

  it('keeps only the most recent turns re-syncable', () => {
    const retained = new Map<string, TranscriptSnapshot>()
    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
      retainTranscriptSnapshot(retained, snapshot(turnId), 2)
    }
    expect([...retained.keys()]).toEqual(['turn-2', 'turn-3'])
  })

  it('refreshes a re-retained turn instead of duplicating it', () => {
    const retained = new Map<string, TranscriptSnapshot>()
    retainTranscriptSnapshot(retained, snapshot('turn-1'), 2)
    retainTranscriptSnapshot(retained, snapshot('turn-2'), 2)
    retainTranscriptSnapshot(retained, { ...snapshot('turn-1'), answer: 'newer' }, 2)
    retainTranscriptSnapshot(retained, snapshot('turn-3'), 2)
    // turn-1 was refreshed, so turn-2 is the oldest arrival and the one dropped.
    expect([...retained.keys()]).toEqual(['turn-1', 'turn-3'])
    expect(retained.get('turn-1')?.answer).toBe('newer')
  })
})
