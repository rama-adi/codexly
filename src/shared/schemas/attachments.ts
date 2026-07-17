import { z } from 'zod'

import { SerializedErrorSchema } from '../errors/serialized-error'
import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MimeTypeSchema,
} from './common'

const AttachmentBaseSchema = z.object({
  version: ContractVersionSchema,
  id: IdentifierSchema,
  kind: z.enum(['audio', 'file', 'image', 'screenshot']),
  name: z.string().trim().min(1).max(255),
  mimeType: MimeTypeSchema,
  byteSize: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  extensions: ExtensionsSchema.optional(),
})

export const AttachmentSchema = z.discriminatedUnion('state', [
  AttachmentBaseSchema.extend({
    state: z.literal('pending'),
  }).strict(),
  AttachmentBaseSchema.extend({
    state: z.literal('ready'),
    reference: z.string().trim().min(1).max(512),
  }).strict(),
  AttachmentBaseSchema.extend({
    state: z.literal('error'),
    error: SerializedErrorSchema,
  }).strict(),
])

export type Attachment = z.infer<typeof AttachmentSchema>
export type AttachmentState = Attachment['state']
