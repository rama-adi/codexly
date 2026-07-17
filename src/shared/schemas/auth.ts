import { z } from 'zod'

import { SerializedErrorSchema } from '../errors/serialized-error'
import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
} from './common'

const AuthStatusBaseSchema = z.object({
  version: ContractVersionSchema,
  extensions: ExtensionsSchema.optional(),
})

export const AuthUserSchema = z
  .object({
    id: IdentifierSchema,
    displayName: z.string().trim().min(1).max(200),
    email: z.string().email().optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict()

export const AuthStatusSchema = z.discriminatedUnion('state', [
  AuthStatusBaseSchema.extend({
    state: z.literal('unauthenticated'),
    reason: z.enum(['signed_out', 'expired', 'revoked']).optional(),
  }).strict(),
  AuthStatusBaseSchema.extend({
    state: z.literal('authenticating'),
    startedAt: IsoDateTimeSchema,
  }).strict(),
  AuthStatusBaseSchema.extend({
    state: z.literal('authenticated'),
    user: AuthUserSchema,
    authenticatedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
  }).strict(),
  AuthStatusBaseSchema.extend({
    state: z.literal('error'),
    error: SerializedErrorSchema,
  }).strict(),
])

export type AuthUser = z.infer<typeof AuthUserSchema>
export type AuthStatus = z.infer<typeof AuthStatusSchema>
