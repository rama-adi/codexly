import { describe, expect, it, vi } from 'vitest'

import type { Attachment } from '../types'
import { createOverlayStore } from './overlay-store'
import type { OverlayTransport } from './contract'

/** Flush pending microtasks/promise callbacks (transport is async). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeStore(transport?: Partial<OverlayTransport>) {
  const stopTurn = vi.fn(async (): Promise<boolean> => true)
  const store = createOverlayStore({
    transport: { stopTurn, ...transport },
  })
  return { store, stopTurn }
}

const attachment = (id: string): Attachment => ({ id, name: `${id}.png`, preview: `data:${id}` })

describe('createOverlayStore — turn dispatch / effects', () => {
  it('interprets a stopTurn effect when the user dismisses mid-stream', async () => {
    const { store, stopTurn } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'solve' })
    s.dispatch({ type: 'started', kind: 'solve', sessionId: 'sess-1', turnId: 'turn-1' })
    expect(store.getState().turn.phase).toBe('active')
    expect(store.getState().turn.scope.turnId).toBe('turn-1')

    // Dismiss while the turn is live → machine emits a stopTurn effect.
    s.dispatch({ type: 'dismiss' })
    expect(stopTurn).toHaveBeenCalledWith('turn-1')
    expect(store.getState().turn.stopInFlight).toBe(true)

    // The resolved stop feeds back a stopSettled input → turn returns to idle.
    await tick()
    expect(store.getState().turn.phase).toBe('idle')
    expect(store.getState().turn.stopInFlight).toBe(false)
  })

  it('interprets a reportError effect when the command settles with a conflicting identity', () => {
    const { store, stopTurn } = makeStore()
    const s = store.getState()

    s.dispatch({ type: 'initiate', kind: 'solve' })
    s.dispatch({ type: 'started', kind: 'solve', sessionId: 'sess-1', turnId: 'turn-1' })

    // The IPC command resolves with a DIFFERENT turn id than the stream latched.
    s.dispatch({ type: 'commandSettled', sessionId: 'sess-1', turnId: 'turn-2' })

    // The conflicting turn is stopped and the error surfaced to the banner.
    expect(stopTurn).toHaveBeenCalledWith('turn-2')
    expect(store.getState().visibleError).toMatch(/identity changed/i)
    expect(store.getState().notice).toMatch(/identity changed/i)
    expect(store.getState().turn.phase).toBe('idle')
  })

  it('returns the TurnResult so callers can read accepted/freshStart', () => {
    const { store } = makeStore()
    const result = store.getState().dispatch({ type: 'initiate', kind: 'chat' })
    expect(result.freshStart).toBe(true)
    expect(result.accepted).toBe(false)
  })
})

describe('createOverlayStore — transcript batching', () => {
  it('accumulates via appendTranscript + flushTranscript and clears via resetTranscript', () => {
    const { store } = makeStore()
    const s = store.getState()

    s.appendTranscript({ answer: 'Hel' })
    s.appendTranscript({ answer: 'lo', reasoning: 'because' })
    s.flushTranscript()

    expect(store.getState().answer).toBe('Hello')
    expect(store.getState().reasoning).toBe('because')

    store.getState().set({ streamError: 'boom' })
    s.resetTranscript()
    expect(store.getState().answer).toBe('')
    expect(store.getState().reasoning).toBe('')
    expect(store.getState().streamError).toBeUndefined()
  })
})

describe('createOverlayStore — tool activity reconciliation', () => {
  it('buffers tool output that arrives before its status, then attaches it', () => {
    const { store } = makeStore()
    const s = store.getState()

    // Output arrives first — no activity exists yet, so it is buffered.
    s.applyToolOutput({ activityId: 'act-1', text: 'partial ' })
    expect(store.getState().activities).toHaveLength(0)

    // Status arrives → the buffered output is attached to the new activity.
    s.applyToolStatus({ activityId: 'act-1', name: 'grep', state: 'running' })
    expect(store.getState().activities).toHaveLength(1)
    expect(store.getState().activities[0].output).toBe('partial ')

    // Later output for the now-known activity appends.
    s.applyToolOutput({ activityId: 'act-1', text: 'more' })
    expect(store.getState().activities[0].output).toBe('partial more')

    s.clearActivities()
    expect(store.getState().activities).toHaveLength(0)
  })

  it('never rolls an activity back to the state of a reordered status', () => {
    const { store } = makeStore()
    const s = store.getState()

    s.applyToolStatus({ activityId: 'act-1', name: 'grep', state: 'running', sequence: 1 })
    s.applyToolStatus({
      activityId: 'act-1',
      name: 'grep',
      state: 'complete',
      detail: 'done',
      sequence: 2,
    })

    // The transport re-delivers the earlier status out of order.
    s.applyToolStatus({ activityId: 'act-1', name: 'grep', state: 'running', sequence: 1 })
    expect(store.getState().activities[0]).toMatchObject({
      state: 'complete',
      detail: 'done',
    })

    // A genuinely newer status still applies.
    s.applyToolStatus({ activityId: 'act-1', name: 'grep', state: 'error', sequence: 3 })
    expect(store.getState().activities[0].state).toBe('error')
  })

  it('keeps applying unsequenced status events so the row is never lost', () => {
    const { store } = makeStore()
    const s = store.getState()

    s.applyToolStatus({ activityId: 'act-1', name: 'grep', state: 'complete' })
    s.applyToolStatus({ activityId: 'act-1', name: 'grep', state: 'running' })
    expect(store.getState().activities[0].state).toBe('running')
  })
})

describe('createOverlayStore — attachment queue reconciliation', () => {
  it('dedups, caps at 5, honors removals, and invalidates a stale bulk load', () => {
    const { store } = makeStore()
    const s = store.getState()

    // Dedup + cap: adding a1..a6 (with a duplicate a1) keeps only the first 5.
    for (const id of ['a1', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']) s.addAttachment(attachment(id))
    let ids = store.getState().attachments.map((a) => a.id)
    expect(ids).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])

    // Remove a1 and confirm a later bulk load cannot re-add it.
    s.removeAttachment('a1')
    s.mergeLoadedAttachments([attachment('a1'), attachment('a7')])
    ids = store.getState().attachments.map((a) => a.id)
    expect(ids).not.toContain('a1')
    expect(ids).toContain('a7')
    expect(ids.length).toBeLessThanOrEqual(5)

    // clearAttachments invalidates any in-flight bulk load result.
    s.clearAttachments()
    expect(store.getState().attachments).toHaveLength(0)
    s.mergeLoadedAttachments([attachment('a8')])
    expect(store.getState().attachments).toHaveLength(0)
  })

  it('un-remembers a re-captured id so it can be added again', () => {
    const { store } = makeStore()
    const s = store.getState()
    s.addAttachment(attachment('a1'))
    s.removeAttachment('a1')
    expect(store.getState().attachments).toHaveLength(0)
    // Re-capturing the same id clears its "removed" mark and re-adds it.
    s.addAttachment(attachment('a1'))
    expect(store.getState().attachments.map((a) => a.id)).toEqual(['a1'])
  })
})
