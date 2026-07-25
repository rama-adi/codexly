import {
  type ProductEvent,
  ProductEventSchema,
  type TranscriptSnapshot,
  TranscriptSnapshotSchema,
} from '../ipc/product'
import { createFixtureContext, type FixtureContext, mergeDefined } from './context'
import { makeSettings } from './settings'

export type ProductEventType = ProductEvent['type']
export type ProductEventOf<K extends ProductEventType> = Extract<ProductEvent, { type: K }>

export type TranscriptSnapshotOverrides = Partial<TranscriptSnapshot>

export function makeTranscriptSnapshot(
  overrides: TranscriptSnapshotOverrides = {},
  context: FixtureContext = createFixtureContext(),
): TranscriptSnapshot {
  const base: TranscriptSnapshot = {
    turnId: context.nextId('turn'),
    sessionId: context.nextId('session'),
    origin: 'overlay',
    sequence: 0,
    answer: '',
    reasoning: '',
    toolOutputs: [],
    live: true,
  }
  return TranscriptSnapshotSchema.parse(mergeDefined(base, overrides))
}

const EVENT_DEFAULTS: {
  [K in ProductEventType]: (context: FixtureContext) => ProductEventOf<K>
} = {
  'conversation.started': (context) => ({
    type: 'conversation.started',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    consumedAttachmentIds: [],
  }),
  'transcript.delta': (context) => ({
    type: 'transcript.delta',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    sequence: 1,
    text: 'fixture answer',
  }),
  'transcript.reasoning': (context) => ({
    type: 'transcript.reasoning',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    sequence: 1,
    text: 'fixture reasoning',
  }),
  'transcript.complete': (context) => ({
    type: 'transcript.complete',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    sequence: 1,
  }),
  'transcript.failed': (context) => ({
    type: 'transcript.failed',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    sequence: 1,
    message: 'fixture failure',
  }),
  'tool.status': (context) => ({
    type: 'tool.status',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    sequence: 1,
    activityId: context.nextId('activity'),
    name: 'shell',
    state: 'running',
  }),
  'tool.output': (context) => ({
    type: 'tool.output',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    sequence: 1,
    activityId: context.nextId('activity'),
    text: 'fixture tool output',
    preliminary: false,
  }),
  'transcript.gap': (context) => ({
    type: 'transcript.gap',
    sessionId: context.nextId('session'),
    turnId: context.nextId('turn'),
    origin: 'overlay',
    evictedThrough: 2,
    droppedCount: 1,
  }),
  'overlay.opened': (context) => ({
    type: 'overlay.opened',
    fresh: true,
    sessionId: context.nextId('session'),
  }),
  'sessions.changed': () => ({ type: 'sessions.changed' }),
  'settings.changed': () => ({ type: 'settings.changed', settings: makeSettings() }),
  'runtime.status': () => ({ type: 'runtime.status', status: { state: 'ready' } }),
  'attachment.captured': (context) => ({
    type: 'attachment.captured',
    attachment: { id: context.nextId('attachment') },
  }),
  'attachments.cleared': () => ({ type: 'attachments.cleared' }),
  'shortcut.error': () => ({
    type: 'shortcut.error',
    action: 'solve',
    phase: 'register',
    message: 'fixture shortcut failure',
  }),
  'shortcut.status': () => ({
    type: 'shortcut.status',
    statuses: {
      solve: {
        accelerator: 'CommandOrControl+Shift+Enter',
        registered: true,
        conflicted: false,
      },
    },
  }),
}

/** Every event discriminant the fixtures know how to build (exhaustive by type). */
export const PRODUCT_EVENT_TYPES = Object.keys(EVENT_DEFAULTS) as readonly ProductEventType[]

/**
 * Build any product event by discriminant, with schema-valid defaults for every
 * required field. The result is parsed, so an override that breaks the contract
 * fails at the fixture rather than deep inside the consumer.
 */
export function makeProductEvent<K extends ProductEventType>(
  type: K,
  overrides: Partial<ProductEventOf<K>> = {},
  context: FixtureContext = createFixtureContext(),
): ProductEventOf<K> {
  const base = EVENT_DEFAULTS[type](context)
  return ProductEventSchema.parse(mergeDefined(base, overrides)) as ProductEventOf<K>
}
