import { z } from 'zod'

import { SerializedErrorSchema } from '../errors/serialized-error'
import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
} from './common'

const SessionBaseSchema = z.object({
  version: ContractVersionSchema,
  id: IdentifierSchema,
  conversationId: IdentifierSchema,
  createdAt: IsoDateTimeSchema,
  extensions: ExtensionsSchema.optional(),
})

export const SessionSchema = z.discriminatedUnion('state', [
  SessionBaseSchema.extend({ state: z.literal('starting') }).strict(),
  SessionBaseSchema.extend({
    state: z.literal('active'),
    startedAt: IsoDateTimeSchema,
  }).strict(),
  SessionBaseSchema.extend({
    state: z.literal('stopping'),
    startedAt: IsoDateTimeSchema,
    stoppingAt: IsoDateTimeSchema,
  }).strict(),
  SessionBaseSchema.extend({
    state: z.literal('ended'),
    startedAt: IsoDateTimeSchema.optional(),
    endedAt: IsoDateTimeSchema,
    reason: z.enum(['cancelled', 'completed', 'signed_out', 'window_closed']),
  }).strict(),
  SessionBaseSchema.extend({
    state: z.literal('error'),
    failedAt: IsoDateTimeSchema,
    error: SerializedErrorSchema,
  }).strict(),
])

export type Session = z.infer<typeof SessionSchema>
export type SessionState = Session['state']
