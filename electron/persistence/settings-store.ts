import { z } from 'zod'

import { AtomicJsonStore } from './atomic-json-store'
import { migrateRecord, type Migration } from './migrations'

/**
 * Temporary local contract until the shared settings contracts land.
 * Replace this schema with the shared import during integration; retain the
 * `version` field and keep credentials/tokens in an OS-backed secret store.
 */
export const SettingsSchema = z
  .object({
    version: z.literal(1),
    theme: z.enum(['system', 'light', 'dark']),
    launchAtLogin: z.boolean(),
  })
  .strict()

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  version: 1,
  theme: 'system',
  launchAtLogin: false,
})

const CURRENT_SETTINGS_VERSION = 1
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
      () => undefined,
      () => undefined,
    )
    return result
  }
}
