import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { AtomicJsonStore } from './atomic-json-store'

const WORKSPACE_INDEX_VERSION = 1
const WORKSPACE_ID_PATTERN = /^workspace_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = z.string().datetime()

export const WorkspaceRecordSchema = z
  .object({
    id: z.string().regex(WORKSPACE_ID_PATTERN),
    title: z.string().min(1).max(512),
    canonicalPath: z.string().min(1),
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
  })
  .strict()

export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>

const WorkspaceIndexSchema = z
  .object({
    version: z.literal(WORKSPACE_INDEX_VERSION),
    selectedWorkspaceId: z.string().regex(WORKSPACE_ID_PATTERN).nullable(),
    workspaces: z.array(WorkspaceRecordSchema),
  })
  .strict()

type WorkspaceIndex = z.infer<typeof WorkspaceIndexSchema>

export type LegacyWorkspaceProfile = Readonly<{ title: string; path: string }>

export type WorkspaceStoreOptions = Readonly<{
  /** Absolute app.getPath('userData') value injected by the Electron main process. */
  userDataPath: string
  /** Canonical workspace paths must be contained by one of these main-process-owned roots. */
  allowedRootPaths: readonly string[]
}>

/**
 * Owns user-selected workspace identities. Renderer callers can select only an
 * existing app ID; they cannot submit a filesystem path through select().
 */
export class WorkspaceStore {
  readonly #store: AtomicJsonStore<WorkspaceIndex>
  readonly #allowedRootPaths: readonly string[]
  #queue: Promise<void> = Promise.resolve()

  constructor({ userDataPath, allowedRootPaths }: WorkspaceStoreOptions) {
    if (allowedRootPaths.length === 0) throw new Error('At least one workspace root is required.')
    if (allowedRootPaths.some((candidate) => !path.isAbsolute(candidate))) {
      throw new Error('Workspace roots must be absolute paths.')
    }
    this.#store = new AtomicJsonStore({ basePath: userDataPath, filename: 'workspace-index.json', schema: WorkspaceIndexSchema })
    this.#allowedRootPaths = [...new Set(allowedRootPaths.map((candidate) => path.resolve(candidate)))]
  }

  /**
   * Registers a path supplied by a trusted native directory picker, never a
   * renderer IPC payload. The canonical target must remain within an approved root.
   */
  async registerApprovedPath(approvedPath: string, title?: string): Promise<WorkspaceRecord> {
    return this.#enqueue(async () => {
      const canonicalPath = await this.#canonicalApprovedPath(approvedPath)
      const index = await this.#loadAndRevalidate()
      const existing = index.workspaces.find((workspace) => workspace.canonicalPath === canonicalPath)
      const now = new Date().toISOString()
      const workspace = WorkspaceRecordSchema.parse(
        existing
          ? { ...existing, title: title?.trim() || existing.title, updatedAt: now }
          : {
              id: `workspace_${randomUUID()}`,
              title: title?.trim() || path.basename(canonicalPath) || canonicalPath,
              canonicalPath,
              createdAt: now,
              updatedAt: now,
            },
      )
      await this.#write({
        ...index,
        selectedWorkspaceId: workspace.id,
        workspaces: [...index.workspaces.filter((candidate) => candidate.id !== workspace.id), workspace],
      })
      return workspace
    })
  }

  /** Select an already-approved app-owned workspace ID; paths are deliberately not accepted. */
  async select(workspaceId: string | null): Promise<WorkspaceRecord | null> {
    if (workspaceId !== null) assertWorkspaceId(workspaceId)
    return this.#enqueue(async () => {
      const index = await this.#loadAndRevalidate()
      const workspace = workspaceId ? index.workspaces.find((candidate) => candidate.id === workspaceId) ?? null : null
      if (workspaceId && !workspace) throw new Error(`Unknown or unavailable workspace: ${workspaceId}`)
      await this.#write({ ...index, selectedWorkspaceId: workspace?.id ?? null })
      return workspace
    })
  }

  async list(): Promise<WorkspaceRecord[]> {
    return this.#enqueue(async () => (await this.#loadAndRevalidate()).workspaces)
  }

  async getSelected(): Promise<WorkspaceRecord | null> {
    return this.#enqueue(async () => {
      const index = await this.#loadAndRevalidate()
      return index.selectedWorkspaceId ? index.workspaces.find((candidate) => candidate.id === index.selectedWorkspaceId) ?? null : null
    })
  }

  async remove(workspaceId: string): Promise<boolean> {
    assertWorkspaceId(workspaceId)
    return this.#enqueue(async () => {
      const index = await this.#loadAndRevalidate()
      if (!index.workspaces.some((workspace) => workspace.id === workspaceId)) return false
      await this.#write({
        ...index,
        selectedWorkspaceId: index.selectedWorkspaceId === workspaceId ? null : index.selectedWorkspaceId,
        workspaces: index.workspaces.filter((workspace) => workspace.id !== workspaceId),
      })
      return true
    })
  }

  /** Used by the one-time legacy importer; legacy IDs are intentionally discarded. */
  async importLegacyProfiles(profiles: readonly LegacyWorkspaceProfile[]): Promise<WorkspaceRecord[]> {
    const imported: WorkspaceRecord[] = []
    for (const profile of profiles) {
      try {
        imported.push(await this.registerApprovedPath(profile.path, profile.title))
      } catch {
        // A stale, missing, or outside-root legacy profile is ignored rather than trusted.
      }
    }
    return imported
  }

  async #loadAndRevalidate(): Promise<WorkspaceIndex> {
    const stored = (await this.#store.read()) ?? { version: WORKSPACE_INDEX_VERSION, selectedWorkspaceId: null, workspaces: [] }
    const valid: WorkspaceRecord[] = []
    for (const workspace of stored.workspaces) {
      try {
        const canonicalPath = await this.#canonicalApprovedPath(workspace.canonicalPath)
        valid.push(WorkspaceRecordSchema.parse({ ...workspace, canonicalPath }))
      } catch {
        // Paths can disappear or escape through a changed symlink after selection.
      }
    }
    const selectedWorkspaceId = valid.some((workspace) => workspace.id === stored.selectedWorkspaceId) ? stored.selectedWorkspaceId : null
    const revalidated = { ...stored, selectedWorkspaceId, workspaces: valid }
    if (JSON.stringify(revalidated) !== JSON.stringify(stored)) await this.#write(revalidated)
    return revalidated
  }

  async #canonicalApprovedPath(candidate: string): Promise<string> {
    if (!path.isAbsolute(candidate)) throw new Error('Workspace paths must be absolute.')
    const canonicalPath = await realpath(candidate)
    const roots = await Promise.all(this.#allowedRootPaths.map((root) => realpath(root)))
    if (!roots.some((root) => isContainedBy(root, canonicalPath))) {
      throw new Error('Workspace path is outside the approved roots.')
    }
    return canonicalPath
  }

  async #write(index: WorkspaceIndex): Promise<void> {
    await this.#store.write(
      WorkspaceIndexSchema.parse({
        ...index,
        workspaces: [...index.workspaces].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)),
      }),
    )
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then((): undefined => undefined, (): undefined => undefined)
    return result
  }
}

function assertWorkspaceId(workspaceId: string): asserts workspaceId is string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Workspace IDs must be app-owned workspace IDs.')
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
