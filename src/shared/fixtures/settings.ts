import {
  type CanonicalSettings,
  CanonicalSettingsSchema,
  DEFAULT_SHORTCUTS,
  SETTINGS_VERSION,
  type Shortcuts,
  ShortcutsSchema,
} from '../schemas/settings'
import type { JsonObject } from '../schemas/common'

/**
 * Section-wise overrides: every section is merged field by field, so a test can
 * change one flag without restating the rest of the canonical document.
 */
export interface SettingsOverrides {
  appearance?: Partial<CanonicalSettings['appearance']>
  application?: Partial<CanonicalSettings['application']>
  privacy?: Partial<CanonicalSettings['privacy']>
  capture?: Partial<CanonicalSettings['capture']>
  assistant?: Partial<CanonicalSettings['assistant']>
  shortcuts?: Partial<Shortcuts>
  extensions?: JsonObject
}

const CANONICAL_SETTINGS: CanonicalSettings = {
  version: SETTINGS_VERSION,
  appearance: { theme: 'system', reducedMotion: false, answerHeight: 600 },
  application: { launchAtLogin: false, showDockIcon: true, startMinimized: false },
  privacy: { persistConversations: true, shareDiagnostics: false, stealthMode: true },
  capture: {
    includeMicrophone: false,
    includeSystemAudio: true,
    screenshotFormat: 'png',
    autoAnswer: false,
  },
  assistant: {
    model: 'codex-default',
    reasoningEffort: 'medium',
    responseLanguage: 'en-US',
    webSearchEnabled: false,
    mode: 'question',
    verbosity: 'concise',
    codingLanguage: 'javascript',
    customInstructionsEnabled: false,
    customInstructions: '',
  },
  shortcuts: { ...DEFAULT_SHORTCUTS },
}

export function makeSettings(overrides: SettingsOverrides = {}): CanonicalSettings {
  return CanonicalSettingsSchema.parse({
    version: SETTINGS_VERSION,
    appearance: { ...CANONICAL_SETTINGS.appearance, ...overrides.appearance },
    application: { ...CANONICAL_SETTINGS.application, ...overrides.application },
    privacy: { ...CANONICAL_SETTINGS.privacy, ...overrides.privacy },
    capture: { ...CANONICAL_SETTINGS.capture, ...overrides.capture },
    assistant: { ...CANONICAL_SETTINGS.assistant, ...overrides.assistant },
    shortcuts: { ...CANONICAL_SETTINGS.shortcuts, ...overrides.shortcuts },
    ...(overrides.extensions ? { extensions: overrides.extensions } : {}),
  })
}

export function makeShortcuts(overrides: Partial<Shortcuts> = {}): Shortcuts {
  return ShortcutsSchema.parse({ ...DEFAULT_SHORTCUTS, ...overrides })
}
