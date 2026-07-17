import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { AtomicJsonStore } from './atomic-json-store'
import { type LegacyWorkspaceProfile, WorkspaceStore } from './workspace-store'

const LEGACY_IMPORT_VERSION = 1
const ISO_DATE = z.string().datetime()

const LegacyProfileSchema = z
  .object({
    title: z.string().optional(),
    path: z.string(),
  })
  .passthrough()

const LegacySettingsSchema = z
  .object({
    model: z.string().optional(),
    stealthEnabled: z.boolean().optional(),
    mode: z.enum(['simpleQA', 'coding']).optional(),
    responseType: z.enum(['concise', 'thorough']).optional(),
    codingLanguage: z.string().optional(),
    responseLanguage: z.string().optional(),
    answerHeight: z.number().min(200).max(1400).optional(),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    webSearchEnabled: z.boolean().optional(),
    launchMode: z.enum(['direct', 'directory']).optional(),
    directoryProfiles: z.array(LegacyProfileSchema).optional(),
    workingDirectory: z.string().optional(),
  })
  .passthrough()

const ImportMarkerSchema = z
  .object({
    version: z.literal(LEGACY_IMPORT_VERSION),
    completedAt: ISO_DATE,
    importedWorkspaceIds: z.array(z.string()),
    importedSettings: z.boolean(),
  })
  .strict()

type ImportMarker = z.infer<typeof ImportMarkerSchema>

export type ImportedLegacySettings = Readonly<{
  model?: string
  stealthEnabled?: boolean
  mode?: 'simpleQA' | 'coding'
  responseType?: 'concise' | 'thorough'
  codingLanguage?: string
  responseLanguage?: string
  answerHeight?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  webSearchEnabled?: boolean
  launchMode?: 'direct' | 'directory'
}>

export type LegacyImportResult = Readonly<{
  imported: boolean
  settings: ImportedLegacySettings
  workspaceIds: readonly string[]
}>

export type LegacyImportOptions = Readonly<{
  /** Absolute app.getPath('userData') path where the import marker belongs. */
  userDataPath: string
  /** Read-only former state directory, e.g. ~/.codexly/userdata. */
  legacyStatePath: string
  workspaceStore: WorkspaceStore
  /** Optional integration point for the new non-secret settings store. */
  importSettings?: (settings: ImportedLegacySettings) => Promise<void>
}>

/**
 * One-time, read-only import of the small legacy settings/profile surface.
 * Secrets, screenshot paths, queues, and Codex rollout/thread ownership are never
 * read or copied. The marker is written only after every requested destination succeeds.
 */
export class LegacyImporter {
  readonly #markerStore: AtomicJsonStore<ImportMarker>
  readonly #legacyStatePath: string
  readonly #workspaceStore: WorkspaceStore
  readonly #importSettings?: (settings: ImportedLegacySettings) => Promise<void>
  #queue: Promise<void> = Promise.resolve()

  constructor({ userDataPath, legacyStatePath, workspaceStore, importSettings }: LegacyImportOptions) {
    if (!path.isAbsolute(legacyStatePath)) throw new Error('Legacy state path must be absolute.')
    this.#markerStore = new AtomicJsonStore({ basePath: userDataPath, filename: 'legacy-import.json', schema: ImportMarkerSchema })
    this.#legacyStatePath = path.resolve(legacyStatePath)
    this.#workspaceStore = workspaceStore
    this.#importSettings = importSettings
  }

  async importOnce(): Promise<LegacyImportResult> {
    return this.#enqueue(async () => {
      const marker = await this.#markerStore.read()
      if (marker) return { imported: false, settings: {}, workspaceIds: marker.importedWorkspaceIds }

      const legacySettings = await readLegacyJson(path.join(this.#legacyStatePath, 'app-settings.json'))
      const parsed = LegacySettingsSchema.safeParse(legacySettings)
      const settings = parsed.success ? sanitizeSettings(parsed.data) : {}
      const profiles = parsed.success ? legacyProfiles(parsed.data) : []
      const workspaces = await this.#workspaceStore.importLegacyProfiles(profiles)
      if (this.#importSettings && Object.keys(settings).length > 0) await this.#importSettings(settings)

      const result: LegacyImportResult = { imported: true, settings, workspaceIds: workspaces.map((workspace) => workspace.id) }
      await this.#markerStore.write({
        version: LEGACY_IMPORT_VERSION,
        completedAt: new Date().toISOString(),
        importedWorkspaceIds: [...result.workspaceIds],
        importedSettings: Object.keys(settings).length > 0,
      })
      return result
    })
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then((): undefined => undefined, (): undefined => undefined)
    return result
  }
}

function sanitizeSettings(settings: z.infer<typeof LegacySettingsSchema>): ImportedLegacySettings {
  const safeSettings = settings
  // Copy only explicitly approved fields; profile paths and passthrough secrets never escape this function.
  return Object.fromEntries(
    Object.entries({
      model: safeSettings.model,
      stealthEnabled: safeSettings.stealthEnabled,
      mode: safeSettings.mode,
      responseType: safeSettings.responseType,
      codingLanguage: safeSettings.codingLanguage,
      responseLanguage: safeSettings.responseLanguage,
      answerHeight: safeSettings.answerHeight,
      reasoningEffort: safeSettings.reasoningEffort,
      webSearchEnabled: safeSettings.webSearchEnabled,
      launchMode: safeSettings.launchMode,
    }).filter(([, value]) => value !== undefined),
  ) as ImportedLegacySettings
}

function legacyProfiles(settings: z.infer<typeof LegacySettingsSchema>): LegacyWorkspaceProfile[] {
  const profiles = settings.directoryProfiles ?? []
  const result = profiles
    .filter((profile): profile is z.infer<typeof LegacyProfileSchema> & { path: string } => typeof profile.path === 'string' && profile.path.length > 0)
    .map((profile) => ({ title: profile.title?.trim() || path.basename(profile.path) || 'Workspace', path: profile.path }))
  if (settings.workingDirectory?.trim() && result.every((profile) => profile.path !== settings.workingDirectory)) {
    result.push({ title: path.basename(settings.workingDirectory) || 'Workspace', path: settings.workingDirectory })
  }
  return result
}

async function readLegacyJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}
