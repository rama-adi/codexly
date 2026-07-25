import type { ProductEvent, TranscriptSnapshot } from '../shared/ipc/product'
import {
  chunkText,
  turnScript,
  type TurnScriptBuilder,
  type TurnScriptOptions,
} from '../shared/fixtures/turn-script'

/**
 * One mutation of a scripted turn, producing AT MOST one product event. The
 * one-event granularity is what lets {@link recordTurn} capture the
 * authoritative transcript after every single event, so the harness can answer
 * `conversation.transcriptSnapshot` with the real main-side prefix at any point
 * of the stream — including content a `transcript.gap` hid from the stream.
 */
export type TurnStep = (builder: TurnScriptBuilder) => void

/** The events published at one point of the stream, plus the snapshot that follows them. */
export interface TurnFrame {
  readonly events: readonly ProductEvent[]
  readonly snapshot: TranscriptSnapshot
}

export interface TurnRecording {
  readonly sessionId: string
  readonly turnId: string
  /** The `conversation.started` announcement, published before any frame. */
  readonly started: ProductEvent
  /** The snapshot before the first frame (sequence 0, nothing streamed). */
  readonly initialSnapshot: TranscriptSnapshot
  readonly frames: readonly TurnFrame[]
}

const deltaSteps = (text: string, chunkSize?: number): TurnStep[] =>
  chunkText(text, chunkSize).map((chunk) => (builder: TurnScriptBuilder) => {
    builder.delta(chunk)
  })

const reasoningSteps = (text: string, chunkSize?: number): TurnStep[] =>
  chunkText(text, chunkSize).map((chunk) => (builder: TurnScriptBuilder) => {
    builder.reasoning(chunk)
  })

const LONG_ANSWER = [
  'The turn registry keeps one record per turn, and that record owns every ',
  'per-turn structure: the deferred queue, the accumulated transcript, and the ',
  'scope that tears all of it down exactly once. Sequence numbers are claimed ',
  'per published event, so a consumer that sees a jump knows the transport ',
  'dropped something and re-syncs against the authoritative snapshot instead of ',
  'appending onto a transcript with a hole in it.',
].join('')

/**
 * The scripted responses the harness can play, named after the canned scenarios
 * in `src/shared/fixtures/turn-script.ts` so the two stay recognisably paired.
 */
export const TURN_RECIPES = {
  shortAnswer: [...deltaSteps('Yes — that compiles cleanly.'), (b) => b.complete()],
  longAnswer: [...deltaSteps(LONG_ANSWER, 24), (b) => b.complete()],
  reasoningHeavy: [
    ...reasoningSteps('Inspecting the turn registry. ', 14),
    ...reasoningSteps('Checking how sequence numbers are claimed. ', 14),
    ...reasoningSteps('Confirming the snapshot answers a re-sync.', 14),
    ...deltaSteps('Sequences are contiguous per turn.'),
    (b) => b.complete(),
  ],
  toolUse: [
    (b) => b.reasoning('Reading the registry first.'),
    (b) =>
      b.toolStatus({
        activityId: 'activity-shell',
        name: 'shell',
        state: 'running',
        detail: 'rg nextSequence',
      }),
    (b) => b.toolOutput('activity-shell', 'electron/app/turn-registry.ts:  nextSequence(): number'),
    (b) => b.toolStatus({ activityId: 'activity-shell', name: 'shell', state: 'complete' }),
    ...deltaSteps('It increments a private per-turn counter.'),
    (b) => b.complete(),
  ],
  failure: [
    ...deltaSteps('Starting the answ'),
    (b) => b.fail('Codex request failed: the app-server closed the stream.'),
  ],
  stopMidStream: [
    (b) => b.reasoning('Planning the answer.'),
    ...deltaSteps('Partial answer that never'),
    (b) => b.stop(),
  ],
  gapAndResync: [
    ...deltaSteps('The first part arrived. '),
    (b) => b.dropDeltas('This middle part was dropped by the transport. '),
    (b) => b.gap(),
    ...deltaSteps('The tail arrived after the gap.'),
    (b) => b.complete(),
  ],
} satisfies Record<string, readonly TurnStep[]>

export type TurnRecipeName = keyof typeof TURN_RECIPES

export const TURN_RECIPE_NAMES = Object.keys(TURN_RECIPES) as TurnRecipeName[]

export const isTurnRecipeName = (value: string): value is TurnRecipeName =>
  Object.prototype.hasOwnProperty.call(TURN_RECIPES, value)

/**
 * Runs a recipe against a fresh {@link TurnScriptBuilder}, capturing the events
 * and the authoritative snapshot after each step. Nothing is published here —
 * the player walks the frames.
 */
export function recordTurn(
  steps: readonly TurnStep[],
  options: TurnScriptOptions = {},
): TurnRecording {
  const builder = turnScript({ ...options, includeStarted: true })
  const announcement = builder.build()
  const started = announcement.events[0]
  if (!started || started.type !== 'conversation.started') {
    throw new Error('recordTurn: the builder did not announce the turn')
  }

  const frames: TurnFrame[] = []
  let published = announcement.events.length
  for (const step of steps) {
    step(builder)
    const built = builder.build()
    frames.push({ events: built.events.slice(published), snapshot: built.snapshot })
    published = built.events.length
  }

  // The main process guarantees exactly one terminal event per announced turn.
  // A recipe that runs out of steps while still live would leave the player with
  // nothing to publish and the renderer's turn machine active forever, so the
  // guarantee is enforced here rather than discovered in a browser.
  if (frames.at(-1)?.snapshot.live !== false) {
    throw new Error('recordTurn: the recipe never reached a terminal event')
  }

  return {
    sessionId: builder.sessionId,
    turnId: builder.turnId,
    started,
    initialSnapshot: announcement.snapshot,
    frames,
  }
}

export function recordRecipe(
  name: TurnRecipeName,
  options: TurnScriptOptions = {},
): TurnRecording {
  return recordTurn(TURN_RECIPES[name], options)
}
