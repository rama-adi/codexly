import { z } from 'zod'

import { BootstrapSchema } from '../schemas/bootstrap'
import { IdentifierSchema } from '../schemas/common'
import { SubscriptionTopicSchema } from './events'
import { createRequestEnvelopeSchema, createResponseEnvelopeSchema } from './envelopes'

const EmptyPayloadSchema = z.object({}).strict()

export const BootstrapRequestSchema = createRequestEnvelopeSchema(EmptyPayloadSchema).extend({
  operation: z.literal('bootstrap.get'),
})

export const BootstrapResponseSchema = createResponseEnvelopeSchema(
  BootstrapSchema,
  z.literal('bootstrap.get'),
)

export const SubscribePayloadSchema = z
  .object({
    topics: z.array(SubscriptionTopicSchema).min(1),
  })
  .strict()

export const SubscribeRequestSchema = createRequestEnvelopeSchema(SubscribePayloadSchema).extend({
  operation: z.literal('subscriptions.subscribe'),
})

export const SubscribeResultSchema = z.object({ subscriptionId: IdentifierSchema }).strict()
export const SubscribeResponseSchema = createResponseEnvelopeSchema(
  SubscribeResultSchema,
  z.literal('subscriptions.subscribe'),
)

export const UnsubscribePayloadSchema = z.object({ subscriptionId: IdentifierSchema }).strict()
export const UnsubscribeRequestSchema = createRequestEnvelopeSchema(
  UnsubscribePayloadSchema,
).extend({ operation: z.literal('subscriptions.unsubscribe') })

export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>
export type SubscribePayload = z.infer<typeof SubscribePayloadSchema>
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>
export type SubscribeResponse = z.infer<typeof SubscribeResponseSchema>
export type UnsubscribePayload = z.infer<typeof UnsubscribePayloadSchema>
export type UnsubscribeRequest = z.infer<typeof UnsubscribeRequestSchema>
