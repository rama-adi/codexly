import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LegacyImporter, type ImportedLegacySettings } from './legacy-import'
import { WorkspaceStore } from './workspace-store'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codexly-legacy-import-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('LegacyImporter', () => {
  it('imports approved settings and profiles once without changing legacy files', async () => {
    const userDataPath = await temporaryDirectory()
    const legacyStatePath = await temporaryDirectory()
    const root = await temporaryDirectory()
    const project = path.join(root, 'project')
    await mkdir(project)
    const legacyFile = path.join(legacyStatePath, 'app-settings.json')
    const legacySource = JSON.stringify({
      model: 'model-a',
      responseType: 'thorough',
      directoryProfiles: [{ id: 'legacy-id', title: 'Project', path: project, screenshotPaths: ['/private/capture.png'] }],
      apiKey: 'must-not-be-imported',
      queue: [{ screenshotPath: '/private/capture.png' }],
      rolloutPath: '/private/rollout.jsonl',
    })
    await writeFile(legacyFile, legacySource, 'utf8')
    const workspaceStore = new WorkspaceStore({ userDataPath, allowedRootPaths: [root] })
    const importedSettings: ImportedLegacySettings[] = []
    const importer = new LegacyImporter({
      userDataPath,
      legacyStatePath,
      workspaceStore,
      importSettings: async (settings) => void importedSettings.push(settings),
    })

    const imported = await importer.importOnce()
    const secondAttempt = await importer.importOnce()

    expect(imported).toMatchObject({ imported: true, settings: { model: 'model-a', responseType: 'thorough' } })
    expect(imported.settings).not.toHaveProperty('apiKey')
    expect(imported.workspaceIds).toHaveLength(1)
    expect(importedSettings).toEqual([{ model: 'model-a', responseType: 'thorough' }])
    expect(secondAttempt).toMatchObject({ imported: false, workspaceIds: imported.workspaceIds })
    expect(await readFile(legacyFile, 'utf8')).toBe(legacySource)
    await expect(readFile(path.join(userDataPath, 'legacy-import.json'), 'utf8')).resolves.not.toContain('must-not-be-imported')
  })
})
