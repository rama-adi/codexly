import { z } from 'zod'

import { ExtensionsSchema } from './common'

/**
 * The persisted settings contract version. Decoupled from CONTRACT_VERSION so
 * that settings-only additions can migrate stored files without forcing every
 * other contract to bump in lockstep.
 */
export const SETTINGS_VERSION = 2 as const
export const SettingsVersionSchema = z.literal(SETTINGS_VERSION)

export const ThemeSchema = z.enum(['system', 'light', 'dark'])
export const ScreenshotFormatSchema = z.enum(['png', 'jpeg'])
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high'])
export const AssistantModeSchema = z.enum(['question', 'coding'])
export const AssistantVerbositySchema = z.enum(['concise', 'verbose'])

export const CanonicalSettingsSchema = z
  .object({
    version: SettingsVersionSchema,
    appearance: z
      .object({
        theme: ThemeSchema,
        reducedMotion: z.boolean(),
        /** Max height, in pixels, of the overlay answer panel. */
        answerHeight: z.number().int().min(200).max(1400),
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
        /** Applies content protection to the overlay window. */
        stealthMode: z.boolean(),
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
        /** Empty string means "let the model decide" (legacy default). */
        responseLanguage: z.string().trim().max(35),
        webSearchEnabled: z.boolean(),
        mode: AssistantModeSchema,
        verbosity: AssistantVerbositySchema,
        codingLanguage: z.string().trim().min(1).max(64),
        customInstructionsEnabled: z.boolean(),
        customInstructions: z.string().max(4000),
      })
      .strict(),
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type Theme = z.infer<typeof ThemeSchema>
export type ScreenshotFormat = z.infer<typeof ScreenshotFormatSchema>
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export type AssistantMode = z.infer<typeof AssistantModeSchema>
export type AssistantVerbosity = z.infer<typeof AssistantVerbositySchema>
export type CanonicalSettings = z.infer<typeof CanonicalSettingsSchema>
