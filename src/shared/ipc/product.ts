import { z } from 'zod'

import { CanonicalSettingsSchema } from '../schemas/settings'

const IdSchema = z.string().trim().min(1).max(256)

export const ProductCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('runtime.status') }).strict(),
  z.object({ type: z.literal('runtime.testConnection') }).strict(),
  z.object({ type: z.literal('models.list') }).strict(),
  z.object({ type: z.literal('auth.useChatGpt') }).strict(),
  z
    .object({
      type: z.literal('auth.setApiKey'),
      apiKey: z.string().trim().min(1).max(512),
      persist: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('settings.get') }).strict(),
  z
    .object({ type: z.literal('settings.update'), settings: CanonicalSettingsSchema })
    .strict(),
  z.object({ type: z.literal('sessions.list') }).strict(),
  z.object({ type: z.literal('sessions.get'), sessionId: IdSchema }).strict(),
  z.object({ type: z.literal('sessions.create') }).strict(),
  z.object({ type: z.literal('sessions.delete'), sessionId: IdSchema }).strict(),
  z.object({ type: z.literal('sessions.reactivate'), sessionId: IdSchema }).strict(),
  z.object({ type: z.literal('workspaces.list') }).strict(),
  z.object({ type: z.literal('workspaces.pick') }).strict(),
  z.object({ type: z.literal('workspaces.select'), workspaceId: IdSchema }).strict(),
  z.object({ type: z.literal('workspaces.remove'), workspaceId: IdSchema }).strict(),
  z
    .object({
      type: z.literal('conversation.send'),
      sessionId: IdSchema.optional(),
      message: z.string().trim().min(1).max(100_000),
      modelId: z.string().trim().min(1).max(128),
      attachmentIds: z.array(IdSchema).max(5),
    })
    .strict(),
  z.object({ type: z.literal('conversation.stop'), turnId: IdSchema }).strict(),
  z
    .object({ type: z.literal('conversation.transcriptSnapshot'), turnId: IdSchema })
    .strict(),
  z.object({ type: z.literal('conversation.solvePending'), modelId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal('attachments.capture') }).strict(),
  z.object({ type: z.literal('attachments.captureSelection') }).strict(),
  z.object({ type: z.literal('attachments.list') }).strict(),
  z
    .object({
      type: z.literal('attachments.getPreviews'),
      attachmentIds: z.array(IdSchema).max(50),
    })
    .strict(),
  z.object({ type: z.literal('attachments.discard'), attachmentId: IdSchema }).strict(),
  z.object({ type: z.literal('attachments.clear') }).strict(),
  z.object({ type: z.literal('window.openHome') }).strict(),
  z
    .object({
      type: z.literal('window.toggleOverlay'),
      preserveSession: z.boolean().optional(),
    })
    .strict(),
  // The height ceiling has to clear the tallest HUD the renderer can build —
  // `appearance.answerHeight` (max 1400) plus panel chrome — or the overlay
  // window would be validated down to less than its own content.
  z.object({ type: z.literal('window.resizeOverlay'), width: z.number().int().min(320).max(1200), height: z.number().int().min(48).max(1600) }).strict(),
  z.object({ type: z.literal('window.setOverlayFocusable'), focusable: z.boolean() }).strict(),
])

export const ProductResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
])

const TurnOriginSchema = z.enum(['overlay', 'homepage'])

export const ConversationTurnResultSchema = z
  .object({
    sessionId: IdSchema,
    turnId: IdSchema,
    consumedAttachmentIds: z.array(IdSchema).max(5),
  })
  .strict()

export type ConversationTurnResult = z.infer<typeof ConversationTurnResultSchema>

/**
 * Per-turn monotonic counter carried by every turn-scoped event the main process
 * publishes. It counts PUBLISHED events only, so a consumer that receives
 * `n + 1` after `n` knows it has the whole stream, and any jump means the
 * transport dropped something (see `transcript.gap`) and the transcript must be
 * re-synced through `conversation.transcriptSnapshot`.
 *
 * The field is optional so the contract stays additive: an event without it is
 * simply not gap-checked.
 */
const SequenceSchema = z.number().int().nonnegative()

export const TranscriptSnapshotSchema = z
  .object({
    turnId: IdSchema,
    sessionId: IdSchema,
    origin: TurnOriginSchema,
    /** Highest sequence included in this snapshot; 0 when nothing was published. */
    sequence: SequenceSchema,
    answer: z.string(),
    reasoning: z.string(),
    toolOutputs: z
      .array(
        z
          .object({ activityId: z.string().min(1).max(256), text: z.string() })
          .strict(),
      )
      .max(200),
    /** False when the turn already ended and this is the retained final copy. */
    live: z.boolean(),
  })
  .strict()

export type TranscriptSnapshot = z.infer<typeof TranscriptSnapshotSchema>

export const ProductEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('conversation.started'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      consumedAttachmentIds: z.array(IdSchema).max(5),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.delta'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      sequence: SequenceSchema.optional(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.reasoning'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      sequence: SequenceSchema.optional(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.complete'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      sequence: SequenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.failed'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      sequence: SequenceSchema.optional(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.status'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      sequence: SequenceSchema.optional(),
      activityId: z.string().min(1).max(256).optional(),
      name: z.string().min(1).max(256),
      state: z.enum(['running', 'complete', 'error']),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.output'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      sequence: SequenceSchema.optional(),
      activityId: z.string().min(1).max(256),
      text: z.string(),
      preliminary: z.boolean(),
    })
    .strict(),
  // Synthesized by the preload transport (never by the main process) when
  // buffer pressure forces it to drop turn-scoped events before a renderer has
  // subscribed. It tells the consumer that the stream it is about to see has a
  // hole, so it must re-sync instead of trusting its own accumulation.
  z
    .object({
      type: z.literal('transcript.gap'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      /** Highest sequence known to have been discarded. */
      evictedThrough: SequenceSchema,
      droppedCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('overlay.opened'),
      fresh: z.boolean(),
      sessionId: IdSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal('sessions.changed') }).strict(),
  z
    .object({ type: z.literal('settings.changed'), settings: CanonicalSettingsSchema })
    .strict(),
  z.object({ type: z.literal('runtime.status'), status: z.unknown() }).strict(),
  z.object({ type: z.literal('attachment.captured'), attachment: z.unknown() }).strict(),
  z.object({ type: z.literal('attachments.cleared') }).strict(),
  z
    .object({
      type: z.literal('shortcut.error'),
      action: IdSchema,
      phase: z.enum(['register', 'unregister', 'callback']),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('shortcut.status'),
      statuses: z.record(
        z.string(),
        z
          .object({
            accelerator: z.string(),
            registered: z.boolean(),
            conflicted: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
])

export type TurnOrigin = z.infer<typeof TurnOriginSchema>
export type ProductCommand = z.infer<typeof ProductCommandSchema>
export type ProductResponse = z.infer<typeof ProductResponseSchema>
export type ProductEvent = z.infer<typeof ProductEventSchema>
