import { z } from 'zod'

import { AuthStatusSchema } from './auth'
import { CapabilitiesSchema } from './capabilities'
import { ContractVersionSchema, ExtensionsSchema, IsoDateTimeSchema } from './common'
import { ConversationSummarySchema } from './conversations'
import { SessionSchema } from './sessions'
import { CanonicalSettingsSchema } from './settings'
import { WindowStatesSchema } from './windows'

export const BootstrapSchema = z
  .object({
    version: ContractVersionSchema,
    generatedAt: IsoDateTimeSchema,
    settings: CanonicalSettingsSchema,
    auth: AuthStatusSchema,
    capabilities: CapabilitiesSchema,
    windows: WindowStatesSchema,
    conversations: z.array(ConversationSummarySchema),
    sessions: z.array(SessionSchema),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type Bootstrap = z.infer<typeof BootstrapSchema>
