import { z } from 'zod'

import { ContractVersionSchema, ExtensionsSchema } from './common'

export const ThemeSchema = z.enum(['system', 'light', 'dark'])
export const ScreenshotFormatSchema = z.enum(['png', 'jpeg'])
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high'])

export const CanonicalSettingsSchema = z
  .object({
    version: ContractVersionSchema,
    appearance: z
      .object({
        theme: ThemeSchema,
        reducedMotion: z.boolean(),
      })
      .strict(),
    application: z
      .object({
        launchAtLogin: z.boolean(),
        showDockIcon: z.boolean(),
        startMinimized: z.boolean(),
      })
      .strict(),
    privacy: z
      .object({
        persistConversations: z.boolean(),
        shareDiagnostics: z.boolean(),
      })
      .strict(),
    capture: z
      .object({
        includeMicrophone: z.boolean(),
        includeSystemAudio: z.boolean(),
        screenshotFormat: ScreenshotFormatSchema,
      })
      .strict(),
    assistant: z
      .object({
        model: z.string().trim().min(1).max(128),
        reasoningEffort: ReasoningEffortSchema,
        responseLanguage: z.string().trim().min(2).max(35),
      })
      .strict(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type Theme = z.infer<typeof ThemeSchema>
export type ScreenshotFormat = z.infer<typeof ScreenshotFormatSchema>
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export type CanonicalSettings = z.infer<typeof CanonicalSettingsSchema>
