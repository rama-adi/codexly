import { z } from 'zod'

import {
  CanonicalSettingsSchema,
  DEFAULT_SHORTCUTS,
  SETTINGS_VERSION,
  SHORTCUT_ACTIONS,
  type CanonicalSettings,
} from '../../src/shared/schemas/settings'
import { AtomicJsonStore } from './atomic-json-store'
import { migrateRecord, type Migration } from './migrations'

/** The persisted, non-secret settings contract shared with the renderer. */
export const SettingsSchema = CanonicalSettingsSchema

export type Settings = CanonicalSettings

/**
 * Lenient on-disk shape used only for reads. It accepts any versioned record so
 * an older settings.json survives long enough to run through the migration
 * pipeline; the strict {@link SettingsSchema} validates the migrated result.
 */
const StoredSettingsSchema = z
  .object({ version: z.number().int().nonnegative() })
  .passthrough()
type StoredSettings = z.infer<typeof StoredSettingsSchema>

export const DEFAULT_SETTINGS = Object.freeze<Settings>({
  version: SETTINGS_VERSION,
  appearance: {
    theme: 'system',
    reducedMotion: false,
    answerHeight: 600,
  },
  application: {
    launchAtLogin: false,
    showDockIcon: true,
    startMinimized: false,
  },
  privacy: {
    persistConversations: true,
    shareDiagnostics: false,
    stealthMode: true,
  },
  capture: {
    includeMicrophone: false,
    includeSystemAudio: false,
    screenshotFormat: 'png',
  },
  assistant: {
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    responseLanguage: '',
    webSearchEnabled: false,
    mode: 'question',
    verbosity: 'concise',
    codingLanguage: 'javascript',
    customInstructionsEnabled: false,
    customInstructions: '',
  },
  shortcuts: { ...DEFAULT_SHORTCUTS },
})

const CURRENT_SETTINGS_VERSION = SETTINGS_VERSION

/**
 * Adds the assistant/privacy/appearance fields introduced alongside the legacy
 * import surface. Existing values are preserved; only missing keys receive the
 * documented defaults so a v1 settings.json upgrades to v2 without data loss.
 */
const migrateSettingsV1ToV2: Migration = {
  from: 1,
  to: 2,
  migrate: (record) => {
    const appearance = asRecord(record.appearance)
    const privacy = asRecord(record.privacy)
    const assistant = asRecord(record.assistant)
    return {
      ...record,
      version: 2,
      appearance: {
        ...appearance,
        answerHeight:
          typeof appearance.answerHeight === 'number'
            ? appearance.answerHeight
            : DEFAULT_SETTINGS.appearance.answerHeight,
      },
      privacy: {
        ...privacy,
        stealthMode:
          typeof privacy.stealthMode === 'boolean'
            ? privacy.stealthMode
            : DEFAULT_SETTINGS.privacy.stealthMode,
      },
      assistant: {
        ...assistant,
        responseLanguage:
          typeof assistant.responseLanguage === 'string'
            ? assistant.responseLanguage
            : DEFAULT_SETTINGS.assistant.responseLanguage,
        webSearchEnabled:
          typeof assistant.webSearchEnabled === 'boolean'
            ? assistant.webSearchEnabled
            : DEFAULT_SETTINGS.assistant.webSearchEnabled,
        mode:
          assistant.mode === 'question' || assistant.mode === 'coding'
            ? assistant.mode
            : DEFAULT_SETTINGS.assistant.mode,
        verbosity:
          assistant.verbosity === 'concise' || assistant.verbosity === 'verbose'
            ? assistant.verbosity
            : DEFAULT_SETTINGS.assistant.verbosity,
        codingLanguage:
          typeof assistant.codingLanguage === 'string' && assistant.codingLanguage.trim()
            ? assistant.codingLanguage
            : DEFAULT_SETTINGS.assistant.codingLanguage,
        customInstructionsEnabled:
          typeof assistant.customInstructionsEnabled === 'boolean'
            ? assistant.customInstructionsEnabled
            : DEFAULT_SETTINGS.assistant.customInstructionsEnabled,
        customInstructions:
          typeof assistant.customInstructions === 'string'
            ? assistant.customInstructions
            : DEFAULT_SETTINGS.assistant.customInstructions,
      },
    }
  },
}

/**
 * Introduces the rebindable global shortcuts. A v2 settings.json has no
 * `shortcuts` section, so every action receives its documented default; any
 * partially-present section keeps the accelerators it already has.
 */
const migrateSettingsV2ToV3: Migration = {
  from: 2,
  to: 3,
  migrate: (record) => {
    const shortcuts = asRecord(record.shortcuts)
    const next: Record<string, string> = {}
    for (const action of SHORTCUT_ACTIONS) {
      const value = shortcuts[action]
      next[action] =
        typeof value === 'string' && value.trim() ? value : DEFAULT_SHORTCUTS[action]
    }
    return { ...record, version: 3, shortcuts: next }
  },
}

const settingsMigrations: readonly Migration[] = [
  migrateSettingsV1ToV2,
  migrateSettingsV2ToV3,
]

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export type SettingsStoreOptions = Readonly<{
  /** Inject app.getPath('userData'); never derive a user path inside the store. */
  userDataPath: string
}>

/** Async settings persistence for non-secret UI preferences only. */
export class SettingsStore {
  readonly #store: AtomicJsonStore<StoredSettings>
  #queue: Promise<void> = Promise.resolve()

  constructor({ userDataPath }: SettingsStoreOptions) {
    this.#store = new AtomicJsonStore({
      basePath: userDataPath,
      filename: 'settings.json',
      schema: StoredSettingsSchema,
    })
  }

  async load(): Promise<Settings> {
    return this.#enqueue(async () => this.#load())
  }

  async save(settings: Settings): Promise<void> {
    const validated = SettingsSchema.parse(settings)
    return this.#enqueue(async () => this.#store.write(validated))
  }

  async update(update: (current: Settings) => Settings): Promise<Settings> {
    return this.#enqueue(async () => {
      const current = await this.#load()
      const next = SettingsSchema.parse(update(current))
      await this.#store.write(next)
      return next
    })
  }

  async #load(): Promise<Settings> {
    const stored = await this.#store.read()
    if (!stored) {
      return DEFAULT_SETTINGS
    }
    return SettingsSchema.parse(migrateRecord(stored, CURRENT_SETTINGS_VERSION, settingsMigrations))
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(
      (): void => undefined,
      (): void => undefined,
    )
    return result
  }
}
