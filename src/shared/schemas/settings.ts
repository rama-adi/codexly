import { z } from 'zod'

import { ExtensionsSchema } from './common'

/**
 * The persisted settings contract version. Decoupled from CONTRACT_VERSION so
 * that settings-only additions can migrate stored files without forcing every
 * other contract to bump in lockstep.
 */
export const SETTINGS_VERSION = 3 as const
export const SettingsVersionSchema = z.literal(SETTINGS_VERSION)

export const ThemeSchema = z.enum(['system', 'light', 'dark'])
export const ScreenshotFormatSchema = z.enum(['png', 'jpeg'])
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high'])
export const AssistantModeSchema = z.enum(['question', 'coding'])
export const AssistantVerbositySchema = z.enum(['concise', 'verbose'])

/**
 * The user-rebindable global shortcuts. Each value is an Electron accelerator
 * string (e.g. "CommandOrControl+Shift+Space"). Order here defines the order the
 * actions are presented in the settings UI.
 */
export const SHORTCUT_ACTIONS = [
  'summonOverlay',
  'toggleOverlay',
  'captureDisplay',
  'captureSelection',
  'solve',
] as const

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

/** Human-facing metadata for each shortcut, consumed by the settings UI. */
export const SHORTCUT_METADATA: Readonly<
  Record<ShortcutAction, { label: string; description: string }>
> = Object.freeze({
  summonOverlay: {
    label: 'Show overlay',
    description: 'Bring the overlay to the front (starts a fresh session).',
  },
  toggleOverlay: {
    label: 'Toggle overlay',
    description: 'Show the overlay, or hide it and return to the home window.',
  },
  captureDisplay: {
    label: 'Capture display',
    description: 'Screenshot the display under the cursor and queue it.',
  },
  captureSelection: {
    label: 'Capture selection',
    description: 'Draw a region to screenshot and queue it.',
  },
  solve: {
    label: 'Solve queued screenshots',
    description: 'Send everything in the queue to the assistant.',
  },
})

/**
 * A single Electron accelerator. Kept intentionally lenient (any non-empty,
 * bounded string) because Electron owns the canonical grammar; the renderer
 * only ever produces well-formed accelerators via the capture control.
 */
export const AcceleratorSchema = z.string().trim().min(1).max(64)

export const ShortcutsSchema = z
  .object({
    summonOverlay: AcceleratorSchema,
    toggleOverlay: AcceleratorSchema,
    captureDisplay: AcceleratorSchema,
    captureSelection: AcceleratorSchema,
    solve: AcceleratorSchema,
  })
  .strict()

/** The default accelerators, shared by the main process and the reset control. */
export const DEFAULT_SHORTCUTS: Readonly<Shortcuts> = Object.freeze({
  summonOverlay: 'CommandOrControl+Shift+Space',
  toggleOverlay: 'CommandOrControl+Shift+B',
  captureDisplay: 'CommandOrControl+Shift+1',
  captureSelection: 'CommandOrControl+Shift+2',
  solve: 'CommandOrControl+Shift+Enter',
})

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
    shortcuts: ShortcutsSchema,
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export type Shortcuts = z.infer<typeof ShortcutsSchema>
export type Theme = z.infer<typeof ThemeSchema>
export type ScreenshotFormat = z.infer<typeof ScreenshotFormatSchema>
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export type AssistantMode = z.infer<typeof AssistantModeSchema>
export type AssistantVerbosity = z.infer<typeof AssistantVerbositySchema>
export type CanonicalSettings = z.infer<typeof CanonicalSettingsSchema>
