import { z } from 'zod'

export const CONTRACT_VERSION = 1 as const
export const ContractVersionSchema = z.literal(CONTRACT_VERSION)

export const IdentifierSchema = z.string().trim().min(1).max(128)
export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const MimeTypeSchema = z
  .string()
  .trim()
  .regex(/^[\w.+-]+\/[\w.+-]+$/)

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
export const ExtensionsSchema = JsonObjectSchema

export type JsonObject = z.infer<typeof JsonObjectSchema>
