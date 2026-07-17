import { z } from 'zod'

import { ContractVersionSchema, ExtensionsSchema, IsoDateTimeSchema } from './common'

export const CapabilityNameSchema = z.enum([
  'codex',
  'filesystem',
  'globalShortcuts',
  'microphone',
  'notifications',
  'screenshots',
  'systemAudio',
  'updater',
  'windowControls',
])

export const CapabilitySchema = z.discriminatedUnion('available', [
  z
    .object({
      name: CapabilityNameSchema,
      available: z.literal(true),
    })
    .strict(),
  z
    .object({
      name: CapabilityNameSchema,
      available: z.literal(false),
      reason: z.enum(['denied', 'restricted', 'unsupported', 'unavailable']),
      detail: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
])

export const CapabilitiesSchema = z
  .object({
    version: ContractVersionSchema,
    platform: z.enum(['darwin', 'linux', 'win32']),
    evaluatedAt: IsoDateTimeSchema,
    items: z.array(CapabilitySchema).superRefine((items, context) => {
      const names = new Set<string>()
      items.forEach((item, index) => {
        if (names.has(item.name)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate capability: ${item.name}`,
            path: [index, 'name'],
          })
        }
        names.add(item.name)
      })
    }),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type CapabilityName = z.infer<typeof CapabilityNameSchema>
export type Capability = z.infer<typeof CapabilitySchema>
export type Capabilities = z.infer<typeof CapabilitiesSchema>
