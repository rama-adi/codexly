import { z } from 'zod'

import { AttachmentSchema } from '../schemas/attachments'
import { AuthStatusSchema } from '../schemas/auth'
import { CapabilitiesSchema } from '../schemas/capabilities'
import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
} from '../schemas/common'
import { ConversationMessageSchema, ConversationSchema } from '../schemas/conversations'
import { SessionSchema } from '../schemas/sessions'
import { CanonicalSettingsSchema } from '../schemas/settings'
import { WindowStateSchema } from '../schemas/windows'

export const SubscriptionTopicSchema = z.enum([
  'attachments',
  'auth',
  'capabilities',
  'conversations',
  'sessions',
  'settings',
  'windows',
])

export const SubscriptionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attachment.changed'), attachment: AttachmentSchema }).strict(),
  z.object({ type: z.literal('auth.changed'), auth: AuthStatusSchema }).strict(),
  z
    .object({ type: z.literal('capabilities.changed'), capabilities: CapabilitiesSchema })
    .strict(),
  z
    .object({ type: z.literal('conversation.upserted'), conversation: ConversationSchema })
    .strict(),
  z.object({ type: z.literal('conversation.deleted'), conversationId: IdentifierSchema }).strict(),
  z.object({ type: z.literal('message.upserted'), message: ConversationMessageSchema }).strict(),
  z.object({ type: z.literal('session.changed'), session: SessionSchema }).strict(),
  z.object({ type: z.literal('settings.changed'), settings: CanonicalSettingsSchema }).strict(),
  z.object({ type: z.literal('window.changed'), window: WindowStateSchema }).strict(),
])

export const SubscriptionEventEnvelopeSchema = z
  .object({
    version: ContractVersionSchema,
    eventId: IdentifierSchema,
    subscriptionId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    emittedAt: IsoDateTimeSchema,
    event: SubscriptionEventSchema,
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type SubscriptionTopic = z.infer<typeof SubscriptionTopicSchema>
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>
export type SubscriptionEventEnvelope = z.infer<typeof SubscriptionEventEnvelopeSchema>
