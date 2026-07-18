import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AtomicJsonStore } from './atomic-json-store'
import { migrateRecord, type Migration } from './migrations'
import { DEFAULT_SETTINGS, SettingsStore } from './settings-store'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codexly-persistence-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('AtomicJsonStore', () => {
  const Schema = z.object({ version: z.literal(1), value: z.number() }).strict()

  it('serializes concurrent writes and preserves the prior valid record as a backup', async () => {
    const directory = await temporaryDirectory()
    const store = new AtomicJsonStore({ basePath: directory, filename: 'state.json', schema: Schema })

    await store.write({ version: 1, value: 0 })
    await Promise.all(Array.from({ length: 20 }, (_, value) => store.write({ version: 1, value })))

    expect(await store.read()).toEqual({ version: 1, value: 19 })
    expect(Schema.parse(JSON.parse(await readFile(path.join(directory, 'state.json.bak'), 'utf8')))).toEqual({ version: 1, value: 18 })
  })

  it('quarantines a corrupt primary and recovers from the validated backup', async () => {
    const directory = await temporaryDirectory()
    const store = new AtomicJsonStore({ basePath: directory, filename: 'state.json', schema: Schema })

    await store.write({ version: 1, value: 1 })
    await store.write({ version: 1, value: 2 })
    await writeFile(path.join(directory, 'state.json'), '{not json', 'utf8')

    expect(await store.read()).toEqual({ version: 1, value: 1 })
    expect(Schema.parse(JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')))).toEqual({ version: 1, value: 1 })
  })

  it('restores a missing primary from the backup', async () => {
    const directory = await temporaryDirectory()
    const store = new AtomicJsonStore({ basePath: directory, filename: 'state.json', schema: Schema })

    await store.write({ version: 1, value: 1 })
    await store.write({ version: 1, value: 2 })
    await unlink(path.join(directory, 'state.json'))

    expect(await store.read()).toEqual({ version: 1, value: 1 })
  })

  it('rejects path-traversal filenames', () => {
    expect(() => new AtomicJsonStore({ basePath: '/tmp', filename: '../state.json', schema: Schema })).toThrow(/safe/i)
  })
})

describe('migrateRecord', () => {
  it('runs each deterministic transition exactly once', () => {
    const migrations: readonly Migration[] = [
      { from: 0, to: 1, migrate: (record) => ({ ...record, version: 1, enabled: true }) },
      { from: 1, to: 2, migrate: (record) => ({ ...record, version: 2, name: 'Codexly' }) },
    ]

    expect(migrateRecord({ version: 0 }, 2, migrations)).toEqual({ version: 2, enabled: true, name: 'Codexly' })
  })

  it('rejects an ambiguous migration plan', () => {
    const migration = { from: 0, to: 1, migrate: (record: { version: number }) => ({ ...record, version: 1 }) }
    expect(() => migrateRecord({ version: 0 }, 1, [migration, migration])).toThrow(/duplicate/i)
  })
})

describe('SettingsStore', () => {
  it('keeps settings non-secret, versioned, and serializes updates', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore({ userDataPath: directory })

    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update((current) => ({
          ...current,
          appearance: { ...current.appearance, theme: index % 2 === 0 ? 'dark' : 'light' },
          application: { ...current.application, launchAtLogin: index % 2 === 0 },
        })),
      ),
    )

    expect(await store.load()).toEqual({
      ...DEFAULT_SETTINGS,
      appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' },
      application: { ...DEFAULT_SETTINGS.application, launchAtLogin: false },
    })
  })

  it('migrates a stored v1 settings.json to v2 with defaults for new fields', async () => {
    const directory = await temporaryDirectory()
    const legacyStored = {
      version: 1,
      appearance: { theme: 'dark', reducedMotion: true },
      application: { launchAtLogin: true, showDockIcon: false, startMinimized: false },
      privacy: { persistConversations: false, shareDiagnostics: true },
      capture: { includeMicrophone: false, includeSystemAudio: false, screenshotFormat: 'jpeg' },
      assistant: { model: 'gpt-old', reasoningEffort: 'high', responseLanguage: 'en' },
    }
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify(legacyStored), 'utf8')

    const store = new SettingsStore({ userDataPath: directory })
    const loaded = await store.load()

    expect(loaded.version).toBe(2)
    // Preserved values survive the upgrade.
    expect(loaded.appearance.theme).toBe('dark')
    expect(loaded.assistant.model).toBe('gpt-old')
    expect(loaded.assistant.reasoningEffort).toBe('high')
    // New fields receive documented defaults.
    expect(loaded.appearance.answerHeight).toBe(600)
    expect(loaded.privacy.stealthMode).toBe(true)
    expect(loaded.assistant.mode).toBe('question')
    expect(loaded.assistant.verbosity).toBe('concise')
    expect(loaded.assistant.webSearchEnabled).toBe(false)
    expect(loaded.assistant.codingLanguage).toBe('javascript')
    expect(loaded.assistant.customInstructionsEnabled).toBe(false)
    expect(loaded.assistant.customInstructions).toBe('')
  })
})
