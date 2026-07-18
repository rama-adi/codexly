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
  z.object({ type: z.literal('conversation.solvePending'), modelId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal('attachments.capture') }).strict(),
  z.object({ type: z.literal('attachments.captureSelection') }).strict(),
  z.object({ type: z.literal('attachments.list') }).strict(),
  z.object({ type: z.literal('attachments.discard'), attachmentId: IdSchema }).strict(),
  z.object({ type: z.literal('attachments.clear') }).strict(),
  z.object({ type: z.literal('window.openHome') }).strict(),
  z
    .object({
      type: z.literal('window.toggleOverlay'),
      preserveSession: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('window.resizeOverlay'), width: z.number().int().min(320).max(1200), height: z.number().int().min(48).max(1200) }).strict(),
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

export const ProductEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('transcript.delta'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.reasoning'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.complete'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.failed'),
      sessionId: IdSchema,
      turnId: IdSchema,
      origin: TurnOriginSchema,
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.status'),
      sessionId: IdSchema,
      origin: TurnOriginSchema,
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
      origin: TurnOriginSchema,
      activityId: z.string().min(1).max(256),
      text: z.string(),
      preliminary: z.boolean(),
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
])

export type TurnOrigin = z.infer<typeof TurnOriginSchema>
export type ProductCommand = z.infer<typeof ProductCommandSchema>
export type ProductResponse = z.infer<typeof ProductResponseSchema>
export type ProductEvent = z.infer<typeof ProductEventSchema>
