import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AttachmentLimitError,
  AttachmentStore,
  AttachmentVerificationError,
} from './attachment-store'

const temporaryDirectories: string[] = []

function png(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
}

async function createStore(
  overrides: Partial<Omit<ConstructorParameters<typeof AttachmentStore>[0], 'userDataPath'>> = {},
) {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'codexly-attachments-'))
  temporaryDirectories.push(userDataPath)
  let sequence = 0
  const store = new AttachmentStore({
    createId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    now: () => new Date('2026-07-18T12:00:00.000Z'),
    ...overrides,
    userDataPath,
  })
  await store.initialize()
  return { store, userDataPath }
}

async function add(store: AttachmentStore, name = 'capture.png') {
  return store.addPendingImage({
    name,
    mimeType: 'image/png',
    bytes: png(),
    width: 1,
    height: 1,
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AttachmentStore', () => {
  it('enforces five pending app-owned attachments', async () => {
    const { store } = await createStore()
    for (let index = 0; index < 5; index += 1) {
      await add(store, `${index}.png`)
    }
    await expect(add(store, 'six.png')).rejects.toBeInstanceOf(AttachmentLimitError)
  })

  it('frees pending capacity when retention is associated', async () => {
    const associated = vi.fn()
    const { store } = await createStore({ retentionHooks: { associated } })
    const first = await add(store)
    for (let index = 1; index < 5; index += 1) {
      await add(store, `${index}.png`)
    }
    await store.associate(first.id, { ownerType: 'conversation', ownerId: 'conversation-1' })
    await expect(add(store, 'replacement.png')).resolves.toBeDefined()
    expect(associated).toHaveBeenCalledOnce()
  })

  it('runs retention hooks outside the serialized store queue', async () => {
    let finishHook: (() => void) | undefined
    const associated = vi.fn(() => new Promise<void>((resolve) => {
      finishHook = resolve
    }))
    const { store } = await createStore({ retentionHooks: { associated } })
    const attachment = await add(store)
    const associating = store.associate(attachment.id, {
      ownerType: 'conversation',
      ownerId: 'conversation-1',
    })
    await vi.waitFor(() => expect(finishHook).toBeDefined())

    await expect(store.list()).resolves.toHaveLength(1)
    finishHook?.()
    await associating
  })

  it('associates a screenshot batch atomically when any requested ID is invalid', async () => {
    const { store } = await createStore()
    const first = await add(store, 'first.png')
    const second = await add(store, 'second.png')
    const association = { ownerType: 'session' as const, ownerId: 'session-1' }

    await expect(
      store.associateMany([first.id, '00000000-0000-0000-0000-000000000000', second.id], association),
    ).rejects.toThrow(/does not exist/i)
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: first.id, associations: [] }),
      expect.objectContaining({ id: second.id, associations: [] }),
    ])
  })

  it('atomically releases the last session owner and deletes its blob without pending overflow', async () => {
    const { store, userDataPath } = await createStore()
    const retained = await add(store, 'retained.png')
    const association = { ownerType: 'session' as const, ownerId: 'session-1' }
    await store.associate(retained.id, association)
    for (let index = 0; index < 5; index += 1) await add(store, `pending-${index}.png`)

    await expect(store.releaseAndDiscard(retained.id, association)).resolves.toBe(true)
    const restarted = new AttachmentStore({ userDataPath })
    await restarted.initialize()
    expect((await restarted.list()).map((attachment) => attachment.id)).not.toContain(retained.id)
    await expect(readdir(path.join(userDataPath, 'attachments', 'blobs'))).resolves.not.toContain(
      `${retained.id}.image`,
    )
  })

  it('rolls back the entire release batch when the second filesystem item fails', async () => {
    const beforeReleaseDiscard = vi.fn(async (_id: string, index: number) => {
      if (index === 1) throw new Error('injected second-item failure')
    })
    const { store, userDataPath } = await createStore({ beforeReleaseDiscard })
    const first = await add(store, 'first.png')
    const second = await add(store, 'second.png')
    const association = { ownerType: 'session' as const, ownerId: 'session-1' }
    await store.associateMany([first.id, second.id], association)

    await expect(
      store.releaseAndDiscardMany([first.id, second.id], association),
    ).rejects.toThrow('injected second-item failure')

    const restarted = new AttachmentStore({ userDataPath })
    await restarted.initialize()
    expect(await restarted.list()).toEqual([
      expect.objectContaining({ id: first.id, associations: [association] }),
      expect.objectContaining({ id: second.id, associations: [association] }),
    ])
    expect(await readdir(path.join(userDataPath, 'attachments', 'blobs'))).toEqual(
      expect.arrayContaining([`${first.id}.image`, `${second.id}.image`]),
    )
  })

  it('enforces the pending limit when releasing retention', async () => {
    const released = vi.fn()
    const { store } = await createStore({ retentionHooks: { released } })
    const retained = await add(store, 'retained.png')
    const association = { ownerType: 'session' as const, ownerId: 'session-1' }
    await store.associate(retained.id, association)
    for (let index = 0; index < 5; index += 1) {
      await add(store, `pending-${index}.png`)
    }

    await expect(store.release(retained.id, association)).rejects.toBeInstanceOf(AttachmentLimitError)
    expect(released).not.toHaveBeenCalled()
  })

  it('does not emit release hooks for an association that is absent', async () => {
    const released = vi.fn()
    const { store } = await createStore({ retentionHooks: { released } })
    const attachment = await add(store)
    await store.release(attachment.id, { ownerType: 'message', ownerId: 'missing' })
    expect(released).not.toHaveBeenCalled()
  })

  it('atomically discards only unassociated pending attachments', async () => {
    const { store, userDataPath } = await createStore()
    const attachment = await add(store)
    await expect(store.discardPending(attachment.id)).resolves.toBe(true)
    await expect(store.list()).resolves.toEqual([])
    expect(await readdir(path.join(userDataPath, 'attachments', 'blobs'))).toEqual([])
  })

  it('resolves bytes only through IDs with verified size, dimensions, and MIME containment', async () => {
    const { store } = await createStore()
    const attachment = await add(store)
    await expect(store.resolveVerifiedBytes(attachment.id, {
      maximumBytes: png().byteLength,
      maximumWidth: 1,
      maximumHeight: 1,
      allowedMimeTypes: ['image/png'],
    })).resolves.toEqual(expect.objectContaining({ attachment }))
    await expect(store.resolveVerifiedBytes('../outside')).rejects.toBeInstanceOf(AttachmentVerificationError)
    await expect(store.resolveVerifiedBytes(attachment.id, { maximumWidth: 0 })).rejects.toThrow('dimensions')
  })

  it('removes size-mismatched blobs and metadata during startup cleanup', async () => {
    const { store, userDataPath } = await createStore()
    const attachment = await add(store)
    const blobPath = path.join(
      userDataPath,
      'attachments',
      'blobs',
      `${attachment.id}.image`,
    )
    await writeFile(blobPath, 'tampered')

    const restarted = new AttachmentStore({ userDataPath })
    await expect(restarted.list()).resolves.toEqual([])
    expect(await readdir(path.dirname(blobPath))).toEqual([])
  })

  it('removes stale temporary and orphan blobs during startup cleanup', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'codexly-stale-'))
    temporaryDirectories.push(userDataPath)
    const blobsPath = path.join(userDataPath, 'attachments', 'blobs')
    await mkdir(blobsPath, { recursive: true })
    await writeFile(path.join(blobsPath, '.old.tmp'), 'temporary')
    await writeFile(path.join(blobsPath, 'orphan.image'), 'orphan')
    const store = new AttachmentStore({ userDataPath })
    await store.list()
    expect(await readdir(blobsPath)).toEqual([])
  })
})
