import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { AtomicJsonStore } from './atomic-json-store'

const SESSION_INDEX_VERSION = 1
const SESSION_RECORD_VERSION = 1
const MAX_LISTED_SESSIONS = 100
const SESSION_ID_PREFIX = 'session_'
const SESSION_ID_PATTERN = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = z.string().datetime()

const AttachmentIdSchema = z.string().min(1).max(256)
const SessionMessageSchema = z
  .object({
    id: z.string().min(1).max(256),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
    attachmentIds: z.array(AttachmentIdSchema).max(100).default([]),
    createdAt: ISO_DATE,
  })
  .strict()

const ToolEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    state: z.enum(['started', 'completed', 'failed']),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    createdAt: ISO_DATE,
  })
  .strict()

const CheckpointSchema = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
    messageId: z.string().min(1).max(256).optional(),
    createdAt: ISO_DATE,
  })
  .strict()

const ContinuationSchema = z
  .object({
    mode: z.literal('continue-as-new'),
    reason: z.literal('missing-thread'),
    previousCodexThreadId: z.string().min(1).nullable(),
    createdAt: ISO_DATE,
  })
  .strict()

export const SessionRecordSchema = z
  .object({
    version: z.literal(SESSION_RECORD_VERSION),
    id: z.string().regex(SESSION_ID_PATTERN),
    title: z.string().min(1).max(512),
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
    workspaceId: z.string().min(1).max(256).nullable(),
    /** External Codex identity; it is never used as this application's session ID. */
    codexThreadId: z.string().min(1).max(1024).nullable(),
    terminalState: z.enum(['active', 'completed', 'failed', 'cancelled']),
    messages: z.array(SessionMessageSchema),
    toolEvents: z.array(ToolEventSchema),
    attachmentIds: z.array(AttachmentIdSchema).max(1_000),
    checkpoints: z.array(CheckpointSchema),
    continuation: ContinuationSchema.nullable(),
  })
  .strict()

export type SessionMessage = z.infer<typeof SessionMessageSchema>
export type SessionToolEvent = z.infer<typeof ToolEventSchema>
export type SessionCheckpoint = z.infer<typeof CheckpointSchema>
export type SessionRecord = z.infer<typeof SessionRecordSchema>

export const SessionIndexEntrySchema = z
  .object({
    id: z.string().regex(SESSION_ID_PATTERN),
    title: z.string().min(1).max(512),
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
    workspaceId: z.string().min(1).max(256).nullable(),
    terminalState: z.enum(['active', 'completed', 'failed', 'cancelled']),
    messageCount: z.number().int().nonnegative(),
    codexThreadId: z.string().min(1).max(1024).nullable(),
    continuation: ContinuationSchema.nullable(),
  })
  .strict()

export type SessionIndexEntry = z.infer<typeof SessionIndexEntrySchema>

const SessionIndexSchema = z
  .object({
    version: z.literal(SESSION_INDEX_VERSION),
    activeSessionId: z.string().regex(SESSION_ID_PATTERN).nullable(),
    sessions: z.array(SessionIndexEntrySchema),
  })
  .strict()

type SessionIndex = z.infer<typeof SessionIndexSchema>

export type CreateSessionInput = Readonly<{
  title?: string
  workspaceId?: string | null
  codexThreadId?: string | null
}>

export type ReactivateSessionOptions = Readonly<{
  /** Main-process result of a thread lookup. Omit only for locally-created sessions without a Codex thread. */
  threadExists?: boolean
}>

export type SessionStoreOptions = Readonly<{
  /** Absolute app.getPath('userData') value injected by the Electron main process. */
  userDataPath: string
}>

/**
 * App-owned history. It only reads and writes files below userData; in particular,
 * it never scans, mutates, or deletes Codex rollout files.
 */
export class SessionStore {
  readonly #indexStore: AtomicJsonStore<SessionIndex>
  readonly #recordDirectory: string
  #queue: Promise<void> = Promise.resolve()

  constructor({ userDataPath }: SessionStoreOptions) {
    this.#indexStore = new AtomicJsonStore({
      basePath: userDataPath,
      filename: 'session-index.json',
      schema: SessionIndexSchema,
    })
    this.#recordDirectory = path.resolve(userDataPath, 'sessions')
  }

  async create(input: CreateSessionInput = {}): Promise<SessionRecord> {
    return this.#enqueue(async () => {
      const now = new Date().toISOString()
      const record = SessionRecordSchema.parse({
        version: SESSION_RECORD_VERSION,
        id: `${SESSION_ID_PREFIX}${randomUUID()}`,
        title: input.title?.trim() || 'New session',
        createdAt: now,
        updatedAt: now,
        workspaceId: input.workspaceId ?? null,
        codexThreadId: input.codexThreadId ?? null,
        terminalState: 'active',
        messages: [],
        toolEvents: [],
        attachmentIds: [],
        checkpoints: [],
        continuation: null,
      })
      await this.#recordStore(record.id).write(record)
      const index = await this.#loadIndex()
      await this.#writeIndex({
        ...index,
        activeSessionId: record.id,
        sessions: this.#upsertIndexEntry(index.sessions, toIndexEntry(record)),
      })
      return record
    })
  }

  /** Reads only the compact index, capped at 100 entries, rather than every session record. */
  async list(limit = MAX_LISTED_SESSIONS): Promise<SessionIndexEntry[]> {
    const safeLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, MAX_LISTED_SESSIONS)) : MAX_LISTED_SESSIONS
    return this.#enqueue(async () => this.#sorted((await this.#loadIndex()).sessions).slice(0, safeLimit))
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    assertSessionId(sessionId)
    return this.#enqueue(async () => (await this.#recordStore(sessionId).read()) ?? null)
  }

  async getActive(): Promise<SessionRecord | null> {
    return this.#enqueue(async () => {
      const activeSessionId = (await this.#loadIndex()).activeSessionId
      return activeSessionId ? (await this.#recordStore(activeSessionId).read()) ?? null : null
    })
  }

  /** Detaches the active-session pointer so the next send starts a fresh session. */
  async clearActive(): Promise<void> {
    return this.#enqueue(async () => {
      const index = await this.#loadIndex()
      if (index.activeSessionId === null) return
      await this.#writeIndex({ ...index, activeSessionId: null })
    })
  }

  async update(sessionId: string, update: (current: SessionRecord) => SessionRecord): Promise<SessionRecord> {
    assertSessionId(sessionId)
    return this.#enqueue(async () => {
      const current = await this.#requireRecord(sessionId)
      const next = SessionRecordSchema.parse({ ...update(current), id: current.id, version: SESSION_RECORD_VERSION, updatedAt: new Date().toISOString() })
      await this.#recordStore(sessionId).write(next)
      const index = await this.#loadIndex()
      await this.#writeIndex({ ...index, sessions: this.#upsertIndexEntry(index.sessions, toIndexEntry(next)) })
      return next
    })
  }

  async appendMessage(sessionId: string, message: SessionMessage): Promise<SessionRecord> {
    const validated = SessionMessageSchema.parse(message)
    return this.update(sessionId, (current) => ({
      ...current,
      messages: [...current.messages, validated],
      attachmentIds: unique([...current.attachmentIds, ...validated.attachmentIds]),
    }))
  }

  async appendToolEvent(sessionId: string, event: SessionToolEvent): Promise<SessionRecord> {
    const validated = ToolEventSchema.parse(event)
    return this.update(sessionId, (current) => ({ ...current, toolEvents: [...current.toolEvents, validated] }))
  }

  async addCheckpoint(sessionId: string, checkpoint: SessionCheckpoint): Promise<SessionRecord> {
    const validated = CheckpointSchema.parse(checkpoint)
    return this.update(sessionId, (current) => ({ ...current, checkpoints: [...current.checkpoints, validated] }))
  }

  async setTerminalState(sessionId: string, terminalState: SessionRecord['terminalState']): Promise<SessionRecord> {
    return this.update(sessionId, (current) => ({ ...current, terminalState }))
  }

  async reactivate(sessionId: string, options: ReactivateSessionOptions = {}): Promise<SessionRecord> {
    assertSessionId(sessionId)
    return this.#enqueue(async () => {
      const current = await this.#requireRecord(sessionId)
      const missingThread = current.codexThreadId === null || options.threadExists === false
      const now = new Date().toISOString()
      const next = SessionRecordSchema.parse({
        ...current,
        updatedAt: now,
        terminalState: 'active',
        codexThreadId: missingThread ? null : current.codexThreadId,
        continuation: missingThread
          ? { mode: 'continue-as-new', reason: 'missing-thread', previousCodexThreadId: current.codexThreadId, createdAt: now }
          : null,
      })
      await this.#recordStore(sessionId).write(next)
      const index = await this.#loadIndex()
      await this.#writeIndex({
        ...index,
        activeSessionId: sessionId,
        sessions: this.#upsertIndexEntry(index.sessions, toIndexEntry(next)),
      })
      return next
    })
  }

  async delete(sessionId: string): Promise<boolean> {
    assertSessionId(sessionId)
    return this.#enqueue(async () => {
      const index = await this.#loadIndex()
      if (!index.sessions.some((entry) => entry.id === sessionId)) return false
      await rm(this.#recordPath(sessionId), { force: true })
      await this.#writeIndex({
        ...index,
        activeSessionId: index.activeSessionId === sessionId ? null : index.activeSessionId,
        sessions: index.sessions.filter((entry) => entry.id !== sessionId),
      })
      return true
    })
  }

  async clear(): Promise<void> {
    return this.#enqueue(async () => {
      const index = await this.#loadIndex()
      await Promise.all(index.sessions.map((entry) => rm(this.#recordPath(entry.id), { force: true })))
      await this.#writeIndex({ version: SESSION_INDEX_VERSION, activeSessionId: null, sessions: [] })
    })
  }

  async #loadIndex(): Promise<SessionIndex> {
    return (await this.#indexStore.read()) ?? { version: SESSION_INDEX_VERSION, activeSessionId: null, sessions: [] }
  }

  async #writeIndex(index: SessionIndex): Promise<void> {
    await this.#indexStore.write(SessionIndexSchema.parse({ ...index, sessions: this.#sorted(index.sessions) }))
  }

  async #requireRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.#recordStore(sessionId).read()
    if (!record) throw new Error(`Unknown app session: ${sessionId}`)
    return record
  }

  #recordStore(sessionId: string): AtomicJsonStore<SessionRecord> {
    return new AtomicJsonStore({ basePath: this.#recordDirectory, filename: `${sessionId}.json`, schema: SessionRecordSchema })
  }

  #recordPath(sessionId: string): string {
    return path.join(this.#recordDirectory, `${sessionId}.json`)
  }

  #upsertIndexEntry(entries: SessionIndexEntry[], entry: SessionIndexEntry): SessionIndexEntry[] {
    return [...entries.filter((candidate) => candidate.id !== entry.id), entry]
  }

  #sorted(entries: SessionIndexEntry[]): SessionIndexEntry[] {
    return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then((): undefined => undefined, (): undefined => undefined)
    return result
  }
}

function toIndexEntry(record: SessionRecord): SessionIndexEntry {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    workspaceId: record.workspaceId,
    terminalState: record.terminalState,
    messageCount: record.messages.length,
    codexThreadId: record.codexThreadId,
    continuation: record.continuation,
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function assertSessionId(sessionId: string): asserts sessionId is string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Session IDs must be app-owned session IDs.')
}
