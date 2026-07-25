import { describe, expect, it } from 'vitest'

import { ProductEventSchema, TranscriptSnapshotSchema } from '../ipc/product'
import { chunkText, TURN_SCENARIOS, type TurnScript, turnScript } from './turn-script'

const sequences = (script: TurnScript): number[] =>
  script.events.flatMap((event) =>
    'sequence' in event && event.sequence !== undefined ? [event.sequence] : [],
  )

const scenarios = Object.entries(TURN_SCENARIOS)

describe('turn scripts', () => {
  it.each(scenarios)('%s produces schema-valid events and snapshot', (_name, scenario) => {
    const script = scenario()
    for (const event of script.events) expect(ProductEventSchema.parse(event)).toEqual(event)
    expect(TranscriptSnapshotSchema.parse(script.snapshot)).toEqual(script.snapshot)
  })

  it.each(scenarios)('%s stamps contiguous sequences from 1', (_name, scenario) => {
    const script = scenario()
    const observed = sequences(script)
    expect(observed.length).toBeGreaterThan(0)
    // Published sequences are strictly increasing and start at 1; only a gap
    // scenario is allowed to skip numbers, and only across its gap marker.
    expect(observed[0]).toBe(1)
    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i]).toBeGreaterThan(observed[i - 1])
    }
    const hasGap = script.events.some((event) => event.type === 'transcript.gap')
    if (!hasGap) {
      expect(observed).toEqual(observed.map((_value, index) => index + 1))
      expect(observed[observed.length - 1]).toBe(script.finalSequence)
    }
  })

  it.each(scenarios)('%s announces the turn and shares one identity', (_name, scenario) => {
    const script = scenario()
    expect(script.events[0]).toMatchObject({
      type: 'conversation.started',
      sessionId: script.sessionId,
      turnId: script.turnId,
    })
    for (const event of script.events) {
      expect(event).toMatchObject({
        sessionId: script.sessionId,
        turnId: script.turnId,
        origin: script.origin,
      })
    }
  })

  it.each(scenarios)('%s ends on a terminal event with a settled snapshot', (_name, scenario) => {
    const script = scenario()
    const last = script.events[script.events.length - 1]
    expect(['transcript.complete', 'transcript.failed']).toContain(last.type)
    expect(script.snapshot.live).toBe(false)
    expect(script.snapshot.sequence).toBe(script.finalSequence)
  })

  it('accumulates the answer the deltas carry', () => {
    const script = TURN_SCENARIOS.shortAnswer()
    const answer = script.events
      .filter((event) => event.type === 'transcript.delta')
      .map((event) => event.text)
      .join('')
    expect(script.snapshot.answer).toBe(answer)
  })

  it('keeps dropped content in the snapshot and skips its sequences in the stream', () => {
    const script = TURN_SCENARIOS.gapAndResync()
    const gap = script.events.find((event) => event.type === 'transcript.gap')
    if (gap?.type !== 'transcript.gap') throw new Error('expected a transcript.gap marker')
    const published = script.events
      .filter((event) => event.type === 'transcript.delta')
      .map((event) => event.text)
      .join('')

    expect(gap.droppedCount).toBeGreaterThan(0)
    expect(script.snapshot.answer).toContain('This middle part was dropped')
    expect(published).not.toContain('This middle part was dropped')
    // The marker names the highest sequence the transport threw away, and the
    // deltas either side of it bracket that number.
    const before = sequences(script).filter((sequence) => sequence < gap.evictedThrough)
    const after = sequences(script).filter((sequence) => sequence > gap.evictedThrough)
    expect(before.length).toBeGreaterThan(0)
    expect(after.length).toBeGreaterThan(0)
    expect(gap.evictedThrough - Math.max(...before)).toBe(gap.droppedCount)
  })

  it('records tool activities in the snapshot', () => {
    const script = TURN_SCENARIOS.toolUse()
    expect(script.snapshot.toolOutputs).toEqual([
      { activityId: 'activity-1', text: 'nextSequence(): number' },
    ])
    expect(
      script.events.filter((event) => event.type === 'tool.status').map((event) => event.state),
    ).toEqual(['running', 'complete'])
  })

  it('turns a stop with no streamed answer into a failure', () => {
    const script = turnScript().reasoning('thinking').stop().build()
    expect(script.events[script.events.length - 1]).toMatchObject({
      type: 'transcript.failed',
      message: 'Response stopped before an answer was returned.',
    })
  })

  it('omits the announcement for a mid-turn resubscribe', () => {
    const script = turnScript({ includeStarted: false }).deltas('tail').complete().build()
    expect(script.events.some((event) => event.type === 'conversation.started')).toBe(false)
    expect(sequences(script)[0]).toBe(1)
  })

  it('rejects events after a terminal one and a gap with nothing dropped', () => {
    const builder = turnScript().deltas('done').complete()
    expect(() => builder.delta('more')).toThrow(/terminal/)
    expect(() => turnScript().gap()).toThrow(/nothing dropped/)
  })

  it('chunks text without losing characters', () => {
    expect(chunkText('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
    expect(chunkText('', 3)).toEqual([])
    expect(() => chunkText('abc', 0)).toThrow()
  })

  it('is deterministic and overridable', () => {
    expect(TURN_SCENARIOS.longAnswer()).toEqual(TURN_SCENARIOS.longAnswer())
    const script = TURN_SCENARIOS.shortAnswer({
      sessionId: 'session-x',
      turnId: 'turn-x',
      origin: 'homepage',
      consumedAttachmentIds: ['shot-1'],
    })
    expect(script.events[0]).toMatchObject({
      origin: 'homepage',
      consumedAttachmentIds: ['shot-1'],
    })
    expect(script.snapshot).toMatchObject({ sessionId: 'session-x', turnId: 'turn-x' })
  })
})
