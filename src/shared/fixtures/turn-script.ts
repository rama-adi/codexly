import type { ProductEvent, TranscriptSnapshot, TurnOrigin } from '../ipc/product'
import { createFixtureContext, type FixtureContext } from './context'

/**
 * Scripted turns: realistic `ProductEvent` streams whose per-turn sequence
 * numbers are contiguous from 1, exactly as `TurnRecord.nextSequence()` stamps
 * them in the main process. `conversation.started` carries no sequence (the main
 * process does not claim one for the announcement), every later turn-scoped
 * event does.
 *
 * The builder also accumulates the authoritative transcript as it goes, so
 * `script.snapshot` is always the answer/reasoning/tool state a re-sync would
 * legitimately return — including content that a `transcript.gap` hid from the
 * event stream.
 */
export interface TurnScript {
  readonly sessionId: string
  readonly turnId: string
  readonly origin: TurnOrigin
  readonly events: readonly ProductEvent[]
  /** The snapshot `conversation.transcriptSnapshot` would answer with. */
  readonly snapshot: TranscriptSnapshot
  /** Highest sequence claimed, whether or not the event was published. */
  readonly finalSequence: number
}

export interface TurnScriptOptions {
  sessionId?: string
  turnId?: string
  origin?: TurnOrigin
  consumedAttachmentIds?: readonly string[]
  /** Emit the `conversation.started` announcement. Defaults to true. */
  includeStarted?: boolean
  context?: FixtureContext
}

export interface ChunkOptions {
  chunkSize?: number
}

const DEFAULT_CHUNK_SIZE = 12

/** Split `text` into `chunkSize`-character delta payloads. */
export function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (chunkSize < 1) throw new Error(`chunkText: chunkSize must be >= 1, got ${chunkSize}`)
  if (text.length === 0) return []
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize))
  }
  return chunks
}

export interface ToolStatusOptions {
  name?: string
  activityId?: string
  state?: 'running' | 'complete' | 'error'
  detail?: string
}

export interface ToolRunOptions {
  name?: string
  activityId?: string
  output?: string
  detail?: string
  /** Final status of the activity. Defaults to `complete`. */
  outcome?: 'complete' | 'error'
}

export class TurnScriptBuilder {
  readonly sessionId: string
  readonly turnId: string
  readonly origin: TurnOrigin
  readonly #context: FixtureContext
  readonly #events: ProductEvent[] = []
  readonly #toolOutputs = new Map<string, string>()
  #sequence = 0
  #answer = ''
  #reasoning = ''
  #terminal = false
  #pendingDrops = 0
  #droppedThrough = 0

  constructor(options: TurnScriptOptions = {}) {
    this.#context = options.context ?? createFixtureContext()
    this.sessionId = options.sessionId ?? this.#context.nextId('session')
    this.turnId = options.turnId ?? this.#context.nextId('turn')
    this.origin = options.origin ?? 'overlay'
    if (options.includeStarted ?? true) {
      this.#events.push({
        type: 'conversation.started',
        sessionId: this.sessionId,
        turnId: this.turnId,
        origin: this.origin,
        consumedAttachmentIds: [...(options.consumedAttachmentIds ?? [])],
      })
    }
  }

  get sequence(): number {
    return this.#sequence
  }

  #assertLive(step: string): void {
    if (this.#terminal) {
      throw new Error(`turnScript: '${step}' after the turn already reached a terminal event`)
    }
  }

  /** One `transcript.delta`. */
  delta(text: string): this {
    this.#assertLive('delta')
    this.#answer += text
    this.#sequence += 1
    this.#events.push({
      type: 'transcript.delta',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      sequence: this.#sequence,
      text,
    })
    return this
  }

  /** `text` chunked into a realistic run of deltas. */
  deltas(text: string, options: ChunkOptions = {}): this {
    for (const chunk of chunkText(text, options.chunkSize)) this.delta(chunk)
    return this
  }

  /** One `transcript.reasoning`. */
  reasoning(text: string): this {
    this.#assertLive('reasoning')
    this.#reasoning += text
    this.#sequence += 1
    this.#events.push({
      type: 'transcript.reasoning',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      sequence: this.#sequence,
      text,
    })
    return this
  }

  /** `text` chunked into a run of reasoning events. */
  reasoningChunks(text: string, options: ChunkOptions = {}): this {
    for (const chunk of chunkText(text, options.chunkSize)) this.reasoning(chunk)
    return this
  }

  toolStatus(options: ToolStatusOptions = {}): this {
    this.#assertLive('toolStatus')
    const activityId = options.activityId ?? this.#context.nextId('activity')
    this.#sequence += 1
    this.#events.push({
      type: 'tool.status',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      sequence: this.#sequence,
      activityId,
      name: options.name ?? 'shell',
      state: options.state ?? 'running',
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    })
    return this
  }

  toolOutput(activityId: string, text: string, preliminary = false): this {
    this.#assertLive('toolOutput')
    const current = this.#toolOutputs.get(activityId)
    this.#toolOutputs.set(activityId, current === undefined ? text : `${current}${text}`)
    this.#sequence += 1
    this.#events.push({
      type: 'tool.output',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      sequence: this.#sequence,
      activityId,
      text,
      preliminary,
    })
    return this
  }

  /** A full tool activity: running status, its output, then the final status. */
  tool(options: ToolRunOptions = {}): this {
    const activityId = options.activityId ?? this.#context.nextId('activity')
    const name = options.name ?? 'shell'
    this.toolStatus({ activityId, name, state: 'running', detail: options.detail })
    if (options.output !== undefined) this.toolOutput(activityId, options.output)
    this.toolStatus({ activityId, name, state: options.outcome ?? 'complete' })
    return this
  }

  /**
   * Content the transport dropped: it claims sequence numbers and lands in the
   * snapshot, but publishes no event. Follow it with {@link gap}.
   */
  dropDeltas(text: string, options: ChunkOptions = {}): this {
    this.#assertLive('dropDeltas')
    for (const chunk of chunkText(text, options.chunkSize)) {
      this.#answer += chunk
      this.#sequence += 1
      this.#pendingDrops += 1
      this.#droppedThrough = this.#sequence
    }
    return this
  }

  /**
   * The preload-synthesized `transcript.gap` marker covering everything dropped
   * since the last gap. It carries no sequence of its own.
   */
  gap(): this {
    this.#assertLive('gap')
    if (this.#pendingDrops === 0) {
      throw new Error('turnScript: gap() with nothing dropped — call dropDeltas first')
    }
    this.#events.push({
      type: 'transcript.gap',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      evictedThrough: this.#droppedThrough,
      droppedCount: this.#pendingDrops,
    })
    this.#pendingDrops = 0
    return this
  }

  complete(): this {
    this.#assertLive('complete')
    this.#sequence += 1
    this.#terminal = true
    this.#events.push({
      type: 'transcript.complete',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      sequence: this.#sequence,
    })
    return this
  }

  fail(message = 'Codex request failed'): this {
    this.#assertLive('fail')
    this.#sequence += 1
    this.#terminal = true
    this.#events.push({
      type: 'transcript.failed',
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      sequence: this.#sequence,
      message,
    })
    return this
  }

  /**
   * A user-requested stop. The main process turns an interrupted turn into
   * `transcript.complete` when partial text was already streamed, and into
   * `transcript.failed` when nothing was.
   */
  stop(): this {
    return this.#answer.trim().length > 0
      ? this.complete()
      : this.fail('Response stopped before an answer was returned.')
  }

  snapshot(): TranscriptSnapshot {
    return {
      turnId: this.turnId,
      sessionId: this.sessionId,
      origin: this.origin,
      sequence: this.#sequence,
      answer: this.#answer,
      reasoning: this.#reasoning,
      toolOutputs: [...this.#toolOutputs].map(([activityId, text]) => ({ activityId, text })),
      live: !this.#terminal,
    }
  }

  build(): TurnScript {
    return {
      sessionId: this.sessionId,
      turnId: this.turnId,
      origin: this.origin,
      events: [...this.#events],
      snapshot: this.snapshot(),
      finalSequence: this.#sequence,
    }
  }
}

export function turnScript(options: TurnScriptOptions = {}): TurnScriptBuilder {
  return new TurnScriptBuilder(options)
}

const LONG_ANSWER = [
  'The registry keeps one record per turn, and the record owns every per-turn ',
  'structure: the deferred queue, the accumulated transcript, and the scope that ',
  'tears all of it down exactly once. Sequence numbers are claimed per published ',
  'event, so a consumer that sees a jump knows the transport dropped something.',
].join('')

export const shortAnswer = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options).deltas('Yes — that compiles cleanly.').complete().build()

export const longAnswer = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options).deltas(LONG_ANSWER, { chunkSize: 24 }).complete().build()

export const reasoningHeavy = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options)
    .reasoning('Inspecting the turn registry.')
    .reasoning('Checking how sequence numbers are claimed.')
    .reasoningChunks('Confirming the snapshot answers a re-sync.', { chunkSize: 16 })
    .deltas('Sequences are contiguous per turn.')
    .complete()
    .build()

export const toolUse = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options)
    .reasoning('Reading the registry first.')
    .tool({ name: 'shell', output: 'nextSequence(): number', detail: 'rg nextSequence' })
    .deltas('It increments a private counter.')
    .complete()
    .build()

export const failure = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options).deltas('Starting the answ').fail('Codex request failed').build()

export const stopMidStream = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options).reasoning('Planning the answer.').deltas('Partial answer that').stop().build()

export const gapAndResync = (options: TurnScriptOptions = {}): TurnScript =>
  turnScript(options)
    .deltas('The first part arrived. ')
    .dropDeltas('This middle part was dropped by the transport. ')
    .gap()
    .deltas('The tail arrived after the gap.')
    .complete()
    .build()

export const TURN_SCENARIOS = {
  shortAnswer,
  longAnswer,
  reasoningHeavy,
  toolUse,
  failure,
  stopMidStream,
  gapAndResync,
} as const

export type TurnScenarioName = keyof typeof TURN_SCENARIOS
