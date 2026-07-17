import { z } from 'zod'

import { SerializedErrorSchema } from '../errors/serialized-error'
import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
} from '../schemas/common'
import { IpcOperationSchema } from './operations'

const EnvelopeBaseShape = {
  version: ContractVersionSchema,
  requestId: IdentifierSchema,
  operation: IpcOperationSchema,
  extensions: ExtensionsSchema.optional(),
}

export const RequestEnvelopeSchema = z
  .object({
    ...EnvelopeBaseShape,
    sentAt: IsoDateTimeSchema,
    payload: JsonValueSchema,
  })
  .strict()

export const ResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ...EnvelopeBaseShape,
      receivedAt: IsoDateTimeSchema,
      ok: z.literal(true),
      data: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      ...EnvelopeBaseShape,
      receivedAt: IsoDateTimeSchema,
      ok: z.literal(false),
      error: SerializedErrorSchema,
    })
    .strict(),
])

export const createRequestEnvelopeSchema = <PayloadSchema extends z.ZodType>(
  payloadSchema: PayloadSchema,
) => RequestEnvelopeSchema.extend({ payload: payloadSchema })

export const createResponseEnvelopeSchema = <
  DataSchema extends z.ZodType,
  OperationSchema extends z.ZodType = typeof IpcOperationSchema,
>(dataSchema: DataSchema, operationSchema = IpcOperationSchema as unknown as OperationSchema) =>
  z.discriminatedUnion('ok', [
    ResponseEnvelopeSchema.options[0].extend({
      operation: operationSchema,
      data: dataSchema,
    }),
    ResponseEnvelopeSchema.options[1].extend({ operation: operationSchema }),
  ])

export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>
