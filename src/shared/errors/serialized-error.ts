import { z } from 'zod'

import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  JsonObjectSchema,
} from '../schemas/common'

export const ErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'unavailable',
  'timeout',
  'cancelled',
  'internal',
])

export const SerializedErrorCauseSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().trim().min(1).max(2_000),
  })
  .strict()

export const SerializedErrorSchema = z
  .object({
    version: ContractVersionSchema,
    code: ErrorCodeSchema,
    message: z.string().trim().min(1).max(2_000),
    retryable: z.boolean(),
    requestId: IdentifierSchema.optional(),
    details: JsonObjectSchema.optional(),
    cause: SerializedErrorCauseSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type SerializedErrorCause = z.infer<typeof SerializedErrorCauseSchema>
export type SerializedError = z.infer<typeof SerializedErrorSchema>
