import { describe, expect, it, vi } from 'vitest'

import type { TranscriptSnapshot } from '../../../shared/ipc/product'
import { createTranscriptSync } from './transcript-sync'

function snapshot(overrides: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot {
  return {
    turnId: 'turn-1',
    sessionId: 'session-1',
    origin: 'overlay',
    sequence: 10,
    answer: 'authoritative answer',
    reasoning: 'authoritative reasoning',
    toolOutputs: [],
    live: true,
    ...overrides,
  }
}

function harness(
  fetchSnapshot: (turnId: string) => Promise<TranscriptSnapshot | null>,
) {
  const applied: TranscriptSnapshot[] = []
  const errors: string[] = []
  const sync = createTranscriptSync({
    fetchSnapshot,
    applySnapshot: (value) => applied.push(value),
    onError: (message) => errors.push(message),
  })
  return { sync, applied, errors }
}

describe('createTranscriptSync sequence classification', () => {
  it('applies contiguous sequences and never re-syncs', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot())
    const { sync, applied } = harness(fetchSnapshot)

    for (const sequence of [1, 2, 3]) {
      expect(sync.classify('turn-1', sequence)).toBe('apply')
      sync.commit('turn-1', sequence)
    }

    await sync.settled('turn-1')
    expect(fetchSnapshot).not.toHaveBeenCalled()
    expect(applied).toEqual([])
  })

  it('treats an unsequenced event as applicable', () => {
    const { sync } = harness(async () => snapshot())
    expect(sync.classify('turn-1', undefined)).toBe('apply')
    sync.commit('turn-1', undefined)
    expect(sync.classify('turn-1', 1)).toBe('apply')
  })

  it('skips a replayed event instead of applying its text twice', () => {
    const { sync } = harness(async () => snapshot())
    sync.commit('turn-1', 4)
    expect(sync.classify('turn-1', 2)).toBe('duplicate')
    expect(sync.classify('turn-1', 4)).toBe('duplicate')
    expect(sync.classify('turn-1', 5)).toBe('apply')
  })

  it('re-syncs when a turn is joined mid-stream', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot({ sequence: 40 }))
    const { sync, applied } = harness(fetchSnapshot)

    // The first sequence ever seen for this turn is 40: everything before it was
    // produced while this window was not listening.
    expect(sync.classify('turn-1', 40)).toBe('gap')
    expect(sync.pending('turn-1')).toBe(true)
    await sync.settled('turn-1')

    expect(fetchSnapshot).toHaveBeenCalledWith('turn-1')
    expect(applied).toEqual([snapshot({ sequence: 40 })])
    // Delta application resumes from the snapshot's sequence.
    expect(sync.classify('turn-1', 41)).toBe('apply')
  })

  it('re-syncs on a hole in the middle and resumes after it', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot({ sequence: 9 }))
    const { sync, applied } = harness(fetchSnapshot)
    expect(sync.classify('turn-1', 1)).toBe('apply')
    sync.commit('turn-1', 1)

    expect(sync.classify('turn-1', 7)).toBe('gap')
    await sync.settled('turn-1')

    expect(applied).toHaveLength(1)
    expect(sync.classify('turn-1', 10)).toBe('apply')
    expect(sync.classify('turn-1', 8)).toBe('duplicate')
  })

  it('coalesces concurrent gaps into one extra pass rather than a fetch per event', async () => {
    let resolveFirst: ((value: TranscriptSnapshot) => void) | undefined
    const fetchSnapshot = vi.fn(
      () =>
        new Promise<TranscriptSnapshot>((resolve) => {
          if (!resolveFirst) {
            resolveFirst = resolve
            return
          }
          resolve(snapshot({ sequence: 30 }))
        }),
    )
    const { sync, applied } = harness(fetchSnapshot)

    expect(sync.classify('turn-1', 5)).toBe('gap')
    // Events arriving during the in-flight fetch are not covered by it.
    expect(sync.classify('turn-1', 20)).toBe('gap')
    expect(sync.classify('turn-1', 21)).toBe('gap')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)

    resolveFirst?.(snapshot({ sequence: 6 }))
    await sync.settled('turn-1')

    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(applied.map((value) => value.sequence)).toEqual([6, 30])
    expect(sync.classify('turn-1', 31)).toBe('apply')
  })

  it('keeps the local transcript when the turn is unknown to the main process', async () => {
    const { sync, applied, errors } = harness(async () => null)
    expect(sync.classify('turn-1', 12)).toBe('gap')
    await sync.settled('turn-1')
    expect(applied).toEqual([])
    expect(errors).toEqual([])
    // Without an authoritative copy the watermark is unchanged, so the next
    // event is still recognised as discontinuous.
    expect(sync.classify('turn-1', 13)).toBe('gap')
  })

  it('reports a failed re-sync instead of throwing into the event handler', async () => {
    const { sync, applied, errors } = harness(async () => {
      throw new Error('bridge unavailable')
    })
    expect(sync.classify('turn-1', 5)).toBe('gap')
    await sync.settled('turn-1')
    expect(applied).toEqual([])
    expect(errors).toEqual(['bridge unavailable'])
  })

  it('re-syncs on an explicit gap marker even when sequences look contiguous', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot({ sequence: 3 }))
    const { sync, applied } = harness(fetchSnapshot)
    sync.commit('turn-1', 1)
    sync.noteGap('turn-1')
    expect(sync.pending('turn-1')).toBe(true)
    await sync.settled('turn-1')
    expect(applied).toHaveLength(1)
    expect(sync.classify('turn-1', 4)).toBe('apply')
  })

  it('forgets a finished turn so a reused watermark cannot leak', () => {
    const { sync } = harness(async () => snapshot())
    sync.commit('turn-1', 9)
    sync.forget('turn-1')
    expect(sync.classify('turn-1', 1)).toBe('apply')
  })

  it('settles immediately when nothing is in flight', async () => {
    const { sync } = harness(async () => snapshot())
    await expect(sync.settled('turn-1')).resolves.toBeUndefined()
  })
})

describe('createTranscriptSync consumer helpers', () => {
  it('gates streaming events, letting only the next one through', () => {
    const { sync } = harness(async () => snapshot({ sequence: 9 }))
    expect(sync.gate({ turnId: 'turn-1', sequence: 1 })).toBe(true)
    expect(sync.gate({ turnId: 'turn-1', sequence: 1 })).toBe(false)
    expect(sync.gate({ turnId: 'turn-1', sequence: 5 })).toBe(false)
    expect(sync.gate({ turnId: 'turn-1', sequence: undefined })).toBe(true)
  })

  it('tracks an unrecoverable event as a hole without ever gating it', async () => {
    const fetchSnapshot = vi.fn(async () => snapshot({ sequence: 9 }))
    const { sync } = harness(fetchSnapshot)
    // The consumer applies these unconditionally — the snapshot carries no tool
    // activity identity, so a skipped status event is lost for good. What the
    // call does is keep the watermark honest and re-sync the text on a hole.
    sync.noteUnrecoverable({ turnId: 'turn-1', sequence: 4 })
    expect(sync.pending('turn-1')).toBe(true)
    await sync.settled('turn-1')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)

    // A contiguous one advances the watermark; one below it is not committed
    // (the authoritative snapshot already covers that range) and not re-fetched.
    sync.noteUnrecoverable({ turnId: 'turn-1', sequence: 10 })
    sync.noteUnrecoverable({ turnId: 'turn-1', sequence: 5 })
    expect(sync.classify('turn-1', 11)).toBe('apply')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('applies a terminal event immediately when the stream was intact', () => {
    const fetchSnapshot = vi.fn(async () => snapshot())
    const { sync } = harness(fetchSnapshot)
    sync.commit('turn-1', 3)
    const applied: string[] = []
    sync.settleTerminal({ turnId: 'turn-1', sequence: 4 }, () => applied.push('terminal'))
    expect(applied).toEqual(['terminal'])
    expect(fetchSnapshot).not.toHaveBeenCalled()
  })

  it('defers a terminal event until the re-sync it triggered has finished', async () => {
    const order: string[] = []
    const { sync } = harness(async () => {
      order.push('snapshot')
      return snapshot({ sequence: 8 })
    })
    sync.commit('turn-1', 1)
    sync.settleTerminal({ turnId: 'turn-1', sequence: 8 }, () => order.push('terminal'))

    // Never dropped, only delayed: the machine still settles.
    expect(order).not.toContain('terminal')
    await vi.waitFor(() => expect(order).toEqual(['snapshot', 'terminal']))
  })

  it('defers a terminal event that lands while an earlier re-sync is still running', async () => {
    const order: string[] = []
    const { sync } = harness(async () => {
      order.push('snapshot')
      return snapshot({ sequence: 8 })
    })
    sync.noteGap('turn-1')
    sync.settleTerminal({ turnId: 'turn-1', sequence: 8 }, () => order.push('terminal'))
    // The terminal event was not covered by the in-flight fetch, so a second
    // pass runs before it is applied.
    await vi.waitFor(() => expect(order).toEqual(['snapshot', 'snapshot', 'terminal']))
  })
})
