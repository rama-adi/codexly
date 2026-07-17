import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceStore } from './workspace-store'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codexly-workspace-store-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('WorkspaceStore', () => {
  it('stores app-owned IDs and canonical paths from approved roots', async () => {
    const userDataPath = await temporaryDirectory()
    const root = await temporaryDirectory()
    const project = path.join(root, 'project')
    await mkdir(project)
    const store = new WorkspaceStore({ userDataPath, allowedRootPaths: [root] })

    const workspace = await store.registerApprovedPath(project, 'Project')

    expect(workspace).toMatchObject({ id: expect.stringMatching(/^workspace_/), title: 'Project', canonicalPath: await realpath(project) })
    expect((await store.getSelected())?.id).toBe(workspace.id)
    await expect(store.select('/renderer-provided/path')).rejects.toThrow(/app-owned/i)
  })

  it('rejects paths outside approved roots and revalidates missing workspaces', async () => {
    const userDataPath = await temporaryDirectory()
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory()
    const project = path.join(root, 'project')
    await mkdir(project)
    const store = new WorkspaceStore({ userDataPath, allowedRootPaths: [root] })

    await expect(store.registerApprovedPath(outside)).rejects.toThrow(/outside/i)
    const workspace = await store.registerApprovedPath(project)
    await rm(project, { recursive: true })

    expect(await store.list()).toEqual([])
    expect(await store.getSelected()).toBeNull()
    await expect(store.select(workspace.id)).rejects.toThrow(/unavailable/i)
  })
})
