import { z } from 'zod'

import { SerializedErrorSchema } from '../errors/serialized-error'
import { AttachmentSchema } from './attachments'
import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
} from './common'

export const TextContentBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(100_000),
  })
  .strict()

export const AttachmentContentBlockSchema = z
  .object({
    type: z.literal('attachment'),
    attachmentId: IdentifierSchema,
  })
  .strict()

export const MessageContentBlockSchema = z.discriminatedUnion('type', [
  TextContentBlockSchema,
  AttachmentContentBlockSchema,
])

const MessageBaseSchema = z.object({
  version: ContractVersionSchema,
  id: IdentifierSchema,
  conversationId: IdentifierSchema,
  role: z.enum(['assistant', 'system', 'user']),
  content: z.array(MessageContentBlockSchema).min(1),
  createdAt: IsoDateTimeSchema,
  extensions: ExtensionsSchema.optional(),
})

export const ConversationMessageSchema = z.discriminatedUnion('state', [
  MessageBaseSchema.extend({ state: z.literal('complete') }).strict(),
  MessageBaseSchema.extend({ state: z.literal('streaming') }).strict(),
  MessageBaseSchema.extend({
    state: z.literal('error'),
    error: SerializedErrorSchema,
  }).strict(),
])

export const ConversationSummarySchema = z
  .object({
    version: ContractVersionSchema,
    id: IdentifierSchema,
    title: z.string().trim().min(1).max(200),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    messageCount: z.number().int().nonnegative(),
    archived: z.boolean(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export const ConversationSchema = z
  .object({
    version: ContractVersionSchema,
    id: IdentifierSchema,
    title: z.string().trim().min(1).max(200),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    archived: z.boolean(),
    messages: z.array(ConversationMessageSchema),
    attachments: z.array(AttachmentSchema),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type TextContentBlock = z.infer<typeof TextContentBlockSchema>
export type AttachmentContentBlock = z.infer<typeof AttachmentContentBlockSchema>
export type MessageContentBlock = z.infer<typeof MessageContentBlockSchema>
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>
export type Conversation = z.infer<typeof ConversationSchema>
