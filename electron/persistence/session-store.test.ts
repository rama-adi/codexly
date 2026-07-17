import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionStore } from './session-store'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codexly-session-store-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SessionStore', () => {
  it('uses application IDs, an index, and separate session records', async () => {
    const userDataPath = await temporaryDirectory()
    const store = new SessionStore({ userDataPath })
    const created = await store.create({ title: 'Build persistence', codexThreadId: 'thread-from-codex' })

    expect(created.id).toMatch(/^session_/)
    expect(created.id).not.toBe(created.codexThreadId)
    await expect(readFile(path.join(userDataPath, 'session-index.json'), 'utf8')).resolves.toContain(created.id)
    await expect(readFile(path.join(userDataPath, 'sessions', `${created.id}.json`), 'utf8')).resolves.toContain('thread-from-codex')
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: created.id, title: 'Build persistence', messageCount: 0, codexThreadId: 'thread-from-codex' }),
    ])
  })

  it('stores messages, attachment IDs, tool events, checkpoints, and terminal state', async () => {
    const store = new SessionStore({ userDataPath: await temporaryDirectory() })
    const session = await store.create()
    const createdAt = new Date().toISOString()

    await store.appendMessage(session.id, { id: 'message-1', role: 'user', content: 'hello', attachmentIds: ['attachment-1'], createdAt })
    await store.appendToolEvent(session.id, { id: 'tool-1', name: 'shell', state: 'completed', output: { ok: true }, createdAt })
    await store.addCheckpoint(session.id, { id: 'checkpoint-1', label: 'Before change', messageId: 'message-1', createdAt })
    const updated = await store.setTerminalState(session.id, 'completed')

    expect(updated).toMatchObject({
      terminalState: 'completed',
      attachmentIds: ['attachment-1'],
      messages: [expect.objectContaining({ id: 'message-1' })],
      toolEvents: [expect.objectContaining({ id: 'tool-1' })],
      checkpoints: [expect.objectContaining({ id: 'checkpoint-1' })],
    })
  })

  it('marks a missing Codex thread for continue-as-new without treating its ID as an app ID', async () => {
    const store = new SessionStore({ userDataPath: await temporaryDirectory() })
    const session = await store.create({ codexThreadId: 'external-thread' })

    const reactivated = await store.reactivate(session.id, { threadExists: false })

    expect(reactivated).toMatchObject({
      id: session.id,
      terminalState: 'active',
      codexThreadId: null,
      continuation: { mode: 'continue-as-new', reason: 'missing-thread', previousCodexThreadId: 'external-thread' },
    })
    expect((await store.getActive())?.id).toBe(session.id)
  })

  it('caps listing at 100 records and clears only app-owned records', async () => {
    const userDataPath = await temporaryDirectory()
    const store = new SessionStore({ userDataPath })
    const created = await Promise.all(Array.from({ length: 101 }, (_, index) => store.create({ title: `Session ${index}` })))

    expect(await store.list(1_000)).toHaveLength(100)
    expect(await store.delete(created[0].id)).toBe(true)
    await store.clear()
    expect(await store.list()).toEqual([])
    expect(await store.get(created[1].id)).toBeNull()
  })

  it('rejects non-application session identifiers', async () => {
    const store = new SessionStore({ userDataPath: await temporaryDirectory() })
    await expect(store.get('codex-thread-id')).rejects.toThrow(/app-owned/i)
  })
})
