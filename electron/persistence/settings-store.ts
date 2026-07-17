import { CONTRACT_VERSION } from '../../src/shared/schemas/common'
import {
  CanonicalSettingsSchema,
  type CanonicalSettings,
} from '../../src/shared/schemas/settings'
import { AtomicJsonStore } from './atomic-json-store'
import { migrateRecord, type Migration } from './migrations'

/** The persisted, non-secret settings contract shared with the renderer. */
export const SettingsSchema = CanonicalSettingsSchema

export type Settings = CanonicalSettings

export const DEFAULT_SETTINGS = Object.freeze<Settings>({
  version: CONTRACT_VERSION,
  appearance: {
    theme: 'system',
    reducedMotion: false,
  },
  application: {
    launchAtLogin: false,
    showDockIcon: true,
    startMinimized: false,
  },
  privacy: {
    persistConversations: true,
    shareDiagnostics: false,
  },
  capture: {
    includeMicrophone: false,
    includeSystemAudio: false,
    screenshotFormat: 'png',
  },
  assistant: {
    model: 'gpt-4o',
    reasoningEffort: 'medium',
    responseLanguage: 'en',
  },
})

const CURRENT_SETTINGS_VERSION = CONTRACT_VERSION
const settingsMigrations: readonly Migration[] = []

export type SettingsStoreOptions = Readonly<{
  /** Inject app.getPath('userData'); never derive a user path inside the store. */
  userDataPath: string
}>

/** Async settings persistence for non-secret UI preferences only. */
export class SettingsStore {
  readonly #store: AtomicJsonStore<Settings>
  #queue: Promise<void> = Promise.resolve()

  constructor({ userDataPath }: SettingsStoreOptions) {
    this.#store = new AtomicJsonStore({
      basePath: userDataPath,
      filename: 'settings.json',
      schema: SettingsSchema,
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
