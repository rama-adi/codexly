import { z } from 'zod'

import { CanonicalSettingsSchema } from '../schemas/settings'

const IdSchema = z.string().trim().min(1).max(256)

export const ProductCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('runtime.status') }).strict(),
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
  z.object({ type: z.literal('attachments.capture') }).strict(),
  z.object({ type: z.literal('window.openHome') }).strict(),
  z.object({ type: z.literal('window.toggleOverlay') }).strict(),
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

export const ProductEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('transcript.delta'),
      sessionId: IdSchema,
      turnId: IdSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.complete'),
      sessionId: IdSchema,
      turnId: IdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('transcript.failed'),
      sessionId: IdSchema,
      turnId: IdSchema,
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.status'),
      sessionId: IdSchema,
      name: z.string().min(1).max(256),
      state: z.enum(['running', 'complete', 'error']),
      detail: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('sessions.changed') }).strict(),
  z.object({ type: z.literal('runtime.status'), status: z.unknown() }).strict(),
  z.object({ type: z.literal('attachment.captured'), attachment: z.unknown() }).strict(),
])

export type ProductCommand = z.infer<typeof ProductCommandSchema>
export type ProductResponse = z.infer<typeof ProductResponseSchema>
export type ProductEvent = z.infer<typeof ProductEventSchema>
