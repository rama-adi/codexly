import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { AtomicJsonStore } from '../persistence/atomic-json-store'

const MAX_PENDING_ATTACHMENTS = 5
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const SAFE_ID = /^[a-f0-9-]{36}$/
const SUPPORTED_MIME_TYPES = ['image/png'] as const

const AssociationSchema = z.object({
  ownerType: z.enum(['conversation', 'message', 'session']),
  ownerId: z.string().min(1).max(255),
}).strict()

const AttachmentRecordSchema = z.object({
  id: z.string().regex(SAFE_ID),
  name: z.string().trim().min(1).max(255),
  mimeType: z.enum(SUPPORTED_MIME_TYPES),
  byteSize: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  createdAt: z.string().datetime(),
  associations: z.array(AssociationSchema),
}).strict()

const AttachmentIndexSchema = z.object({
  version: z.literal(1),
  attachments: z.array(AttachmentRecordSchema),
}).strict()

type AttachmentIndex = z.infer<typeof AttachmentIndexSchema>
export type AttachmentAssociation = z.infer<typeof AssociationSchema>
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>
export type SupportedImageMimeType = AttachmentRecord['mimeType']

export type PendingImageInput = Readonly<{
  name: string
  mimeType: SupportedImageMimeType
  bytes: Uint8Array
  width: number
  height: number
}>

export type VerifiedAttachment = Readonly<{
  attachment: AttachmentRecord
  bytes: Buffer
}>

export type AttachmentResolutionConstraints = Readonly<{
  maximumBytes?: number
  maximumWidth?: number
  maximumHeight?: number
  allowedMimeTypes?: readonly SupportedImageMimeType[]
}>

export interface AttachmentRetentionHooks {
  associated?(attachment: AttachmentRecord, association: AttachmentAssociation): void | Promise<void>
  released?(attachment: AttachmentRecord, association: AttachmentAssociation): void | Promise<void>
}

export type AttachmentStoreOptions = Readonly<{
  userDataPath: string
  createId?: () => string
  now?: () => Date
  retentionHooks?: AttachmentRetentionHooks
  /** Deterministic fault/telemetry seam invoked for every item before the batch commit. */
  beforeReleaseDiscard?: (attachmentId: string, index: number) => void | Promise<void>
}>

export class AttachmentLimitError extends Error {
  constructor() {
    super(`No more than ${MAX_PENDING_ATTACHMENTS} pending attachments are allowed.`)
    this.name = 'AttachmentLimitError'
  }
}

export class AttachmentVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentVerificationError'
  }
}

export class AttachmentStore {
  private readonly rootPath: string
  private readonly blobsPath: string
  private readonly metadataStore: AtomicJsonStore<AttachmentIndex>
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly retentionHooks: AttachmentRetentionHooks
  private readonly beforeReleaseDiscard?: AttachmentStoreOptions['beforeReleaseDiscard']
  private queue: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(options: AttachmentStoreOptions) {
    if (!path.isAbsolute(options.userDataPath)) {
      throw new Error('Attachment userDataPath must be absolute.')
    }
    this.rootPath = path.join(options.userDataPath, 'attachments')
    this.blobsPath = path.join(this.rootPath, 'blobs')
    this.metadataStore = new AtomicJsonStore({
      basePath: this.rootPath,
      filename: 'attachments.json',
      schema: AttachmentIndexSchema,
    })
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.retentionHooks = options.retentionHooks ?? {}
    this.beforeReleaseDiscard = options.beforeReleaseDiscard
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => this.initializeUnsafe())
  }

  addPendingImage(input: PendingImageInput): Promise<AttachmentRecord> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const index = await this.readIndex()
      if (index.attachments.filter((attachment) => attachment.associations.length === 0).length >= MAX_PENDING_ATTACHMENTS) {
        throw new AttachmentLimitError()
      }

      const bytes = Buffer.from(input.bytes)
      validateInput(input, bytes)
      const detected = inspectImage(bytes)
      if (detected.mimeType !== input.mimeType) {
        throw new AttachmentVerificationError('Declared MIME type does not match the image bytes.')
      }
      if (detected.width !== input.width || detected.height !== input.height) {
        throw new AttachmentVerificationError('Declared image dimensions do not match the image bytes.')
      }

      const id = this.createId()
      if (!SAFE_ID.test(id) || index.attachments.some((attachment) => attachment.id === id)) {
        throw new Error('Attachment ID generator returned an invalid or duplicate ID.')
      }
      const attachment = AttachmentRecordSchema.parse({
        id,
        name: input.name,
        mimeType: input.mimeType,
        byteSize: bytes.byteLength,
        width: input.width,
        height: input.height,
        createdAt: this.now().toISOString(),
        associations: [],
      })
      const blobPath = this.pathForId(id)
      await this.writeBlobAtomic(blobPath, bytes)
      try {
        await this.metadataStore.write({
          version: 1,
          attachments: [...index.attachments, attachment],
        })
      } catch (error) {
        await unlink(blobPath).catch(() => undefined)
        throw error
      }
      return attachment
    })
  }

  discardPending(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const index = await this.readIndex()
      const attachment = index.attachments.find((candidate) => candidate.id === id)
      if (!attachment) {
        return false
      }
      if (attachment.associations.length > 0) {
        throw new AttachmentVerificationError('Associated attachments cannot be discarded as pending.')
      }
      const blobPath = this.pathForId(id)
      const tombstonePath = this.containedBlobPath(
        `.${this.filename(id)}.${randomUUID()}.discard`,
      )
      let moved = false
      try {
        await rename(blobPath, tombstonePath)
        await syncDirectory(this.blobsPath)
        moved = true
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
      try {
        await this.metadataStore.write({
          version: 1,
          attachments: index.attachments.filter((candidate) => candidate.id !== id),
        })
      } catch (error) {
        if (moved) {
          await rename(tombstonePath, blobPath).catch(() => undefined)
          await syncDirectory(this.blobsPath).catch(() => undefined)
        }
        throw error
      }
      if (moved) {
        await unlink(tombstonePath).catch(() => undefined)
        await syncDirectory(this.blobsPath).catch(() => undefined)
      }
      return true
    })
  }

  resolveVerifiedBytes(
    id: string,
    constraints: AttachmentResolutionConstraints = {},
  ): Promise<VerifiedAttachment> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      if (!SAFE_ID.test(id)) {
        throw new AttachmentVerificationError('Attachment ID is not app-owned.')
      }
      const index = await this.readIndex()
      const attachment = index.attachments.find((candidate) => candidate.id === id)
      if (!attachment) {
        throw new AttachmentVerificationError('Attachment does not exist.')
      }
      const bytes = await readFile(this.pathForId(id))
      const actual = inspectImage(bytes)
      const maximumBytes = constraints.maximumBytes ?? MAX_IMAGE_BYTES
      if (bytes.byteLength !== attachment.byteSize || bytes.byteLength > maximumBytes) {
        throw new AttachmentVerificationError('Attachment byte size is outside its verified bounds.')
      }
      if (
        actual.mimeType !== attachment.mimeType ||
        actual.width !== attachment.width ||
        actual.height !== attachment.height
      ) {
        throw new AttachmentVerificationError('Attachment metadata does not match its bytes.')
      }
      if (constraints.allowedMimeTypes && !constraints.allowedMimeTypes.includes(actual.mimeType)) {
        throw new AttachmentVerificationError('Attachment MIME type is not allowed here.')
      }
      if (
        actual.width > (constraints.maximumWidth ?? Number.MAX_SAFE_INTEGER) ||
        actual.height > (constraints.maximumHeight ?? Number.MAX_SAFE_INTEGER)
      ) {
        throw new AttachmentVerificationError('Attachment dimensions are outside their allowed bounds.')
      }
      return { attachment, bytes }
    })
  }

  async associate(id: string, association: AttachmentAssociation): Promise<AttachmentRecord> {
    const parsed = AssociationSchema.parse(association)
    const result = await this.updateAssociation(id, parsed, true)
    if (result.changed) {
      await this.retentionHooks.associated?.(result.attachment, parsed)
    }
    return result.attachment
  }

  async associateMany(
    ids: readonly string[],
    association: AttachmentAssociation,
  ): Promise<readonly AttachmentRecord[]> {
    const parsed = AssociationSchema.parse(association)
    const uniqueIds = [...new Set(ids)]
    const result = await this.enqueue(async () => {
      await this.ensureInitialized()
      const index = await this.readIndex()
      const requested = new Set(uniqueIds)
      const found = index.attachments.filter((attachment) => requested.has(attachment.id))
      if (found.length !== uniqueIds.length) {
        throw new AttachmentVerificationError('Attachment does not exist.')
      }
      const matches = (candidate: AttachmentAssociation) =>
        candidate.ownerType === parsed.ownerType && candidate.ownerId === parsed.ownerId
      const changed = found.filter((attachment) => !attachment.associations.some(matches))
      if (changed.length === 0) return { attachments: found, changed: [] as AttachmentRecord[] }
      const changedIds = new Set(changed.map((attachment) => attachment.id))
      const attachments = index.attachments.map((attachment) =>
        changedIds.has(attachment.id)
          ? AttachmentRecordSchema.parse({
              ...attachment,
              associations: [...attachment.associations, parsed],
            })
          : attachment,
      )
      await this.metadataStore.write({ version: 1, attachments })
      return {
        attachments: uniqueIds.map((id) => attachments.find((item) => item.id === id)!),
        changed: attachments.filter((attachment) => changedIds.has(attachment.id)),
      }
    })
    for (const attachment of result.changed) {
      await Promise.resolve(this.retentionHooks.associated?.(attachment, parsed)).catch(
        () => undefined,
      )
    }
    return result.attachments
  }

  /** Atomically drops one owner and destroys the blob when no owners remain. */
  async releaseAndDiscard(
    id: string,
    association: AttachmentAssociation,
  ): Promise<boolean> {
    return (await this.releaseAndDiscardMany([id], association)).removedIds.includes(id)
  }

  /**
   * Releases one owner across a batch with a single metadata commit. Final-owner
   * blobs are removed only after that commit; an interrupted cleanup can leave
   * only harmless orphan blobs that startup reconciliation removes, so retrying
   * can never observe a half-released metadata batch.
   */
  async releaseAndDiscardMany(
    ids: readonly string[],
    association: AttachmentAssociation,
  ): Promise<Readonly<{ releasedIds: readonly string[]; removedIds: readonly string[] }>> {
    const parsed = AssociationSchema.parse(association)
    const uniqueIds = [...new Set(ids)]
    const result = await this.enqueue(async () => {
      await this.ensureInitialized()
      const index = await this.readIndex()
      const matches = (candidate: AttachmentAssociation) =>
        candidate.ownerType === parsed.ownerType && candidate.ownerId === parsed.ownerId
      const requested = new Set(uniqueIds)
      const released = index.attachments
        .filter((attachment) => requested.has(attachment.id) && attachment.associations.some(matches))
        .map((attachment) =>
          AttachmentRecordSchema.parse({
            ...attachment,
            associations: attachment.associations.filter((candidate) => !matches(candidate)),
          }),
        )
      const releasedById = new Map(released.map((attachment) => [attachment.id, attachment]))
      const removed = released.filter((attachment) => attachment.associations.length === 0)
      const removedIds = new Set(removed.map((attachment) => attachment.id))
      // Validate every batch step before the one atomic metadata commit. A
      // crash after that commit can leave only unreferenced blobs, which the
      // existing startup reconciliation safely removes; it can never leave a
      // retained metadata record pointing at a blob moved by a partial batch.
      for (const [itemIndex, attachment] of removed.entries()) {
        await this.beforeReleaseDiscard?.(attachment.id, itemIndex)
      }
      const attachments = index.attachments.flatMap((attachment) => {
        if (removedIds.has(attachment.id)) return []
        const updated = releasedById.get(attachment.id)
        return [updated ?? attachment]
      })
      if (released.length > 0) {
        await this.metadataStore.write({ version: 1, attachments })
      }
      await Promise.all(
        removed.map((attachment) => unlink(this.pathForId(attachment.id)).catch(ignoreMissing)),
      )
      if (removed.length > 0) await syncDirectory(this.blobsPath).catch(() => undefined)
      return { released, removedIds: [...removedIds] }
    })
    for (const attachment of result.released) {
      await Promise.resolve(this.retentionHooks.released?.(attachment, parsed)).catch(
        () => undefined,
      )
    }
    return {
      releasedIds: result.released.map((attachment) => attachment.id),
      removedIds: result.removedIds,
    }
  }

  async release(id: string, association: AttachmentAssociation): Promise<AttachmentRecord> {
    const parsed = AssociationSchema.parse(association)
    const result = await this.updateAssociation(id, parsed, false)
    if (result.changed) {
      await this.retentionHooks.released?.(result.attachment, parsed)
    }
    return result.attachment
  }

  list(): Promise<readonly AttachmentRecord[]> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      return (await this.readIndex()).attachments
    })
  }

  private updateAssociation(
    id: string,
    association: AttachmentAssociation,
    add: boolean,
  ): Promise<Readonly<{ attachment: AttachmentRecord; changed: boolean }>> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const index = await this.readIndex()
      const position = index.attachments.findIndex((attachment) => attachment.id === id)
      if (position < 0) {
        throw new AttachmentVerificationError('Attachment does not exist.')
      }
      const current = index.attachments[position]
      const matches = (candidate: AttachmentAssociation) =>
        candidate.ownerType === association.ownerType && candidate.ownerId === association.ownerId
      const associated = current.associations.some(matches)
      if (add === associated) {
        return { attachment: current, changed: false }
      }
      if (
        !add &&
        current.associations.length === 1 &&
        index.attachments.filter((attachment) =>
          attachment.id !== id && attachment.associations.length === 0
        ).length >= MAX_PENDING_ATTACHMENTS
      ) {
        throw new AttachmentLimitError()
      }
      const associations = add
        ? [...current.associations, association]
        : current.associations.filter((candidate) => !matches(candidate))
      const updated = AttachmentRecordSchema.parse({ ...current, associations })
      const attachments = [...index.attachments]
      attachments[position] = updated
      await this.metadataStore.write({ version: 1, attachments })
      return { attachment: updated, changed: true }
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initializeUnsafe()
    }
  }

  private async initializeUnsafe(): Promise<void> {
    if (this.initialized) {
      return
    }
    await mkdir(this.blobsPath, { recursive: true })
    const index = await this.readIndex()
    const directoryEntries = await readdir(this.blobsPath, { withFileTypes: true })
    const knownFiles = new Set(index.attachments.map((attachment) => this.filename(attachment.id)))

    for (const entry of directoryEntries) {
      const entryPath = this.containedBlobPath(entry.name)
      if (entry.isFile() && (entry.name.endsWith('.tmp') || !knownFiles.has(entry.name))) {
        await unlink(entryPath).catch(ignoreMissing)
      }
    }

    const valid: AttachmentRecord[] = []
    for (const attachment of index.attachments) {
      try {
        const details = await stat(this.pathForId(attachment.id))
        if (details.isFile() && details.size === attachment.byteSize) {
          valid.push(attachment)
        } else if (details.isFile()) {
          await unlink(this.pathForId(attachment.id)).catch(ignoreMissing)
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
    }
    if (valid.length !== index.attachments.length) {
      await this.metadataStore.write({ version: 1, attachments: valid })
    }
    this.initialized = true
  }

  private async readIndex(): Promise<AttachmentIndex> {
    return (await this.metadataStore.read()) ?? { version: 1, attachments: [] }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private pathForId(id: string): string {
    if (!SAFE_ID.test(id)) {
      throw new AttachmentVerificationError('Attachment ID is not app-owned.')
    }
    return this.containedBlobPath(this.filename(id))
  }

  private filename(id: string): string {
    return `${id}.image`
  }

  private containedBlobPath(filename: string): string {
    const candidate = path.resolve(this.blobsPath, filename)
    const relative = path.relative(this.blobsPath, candidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AttachmentVerificationError('Attachment path escapes its storage root.')
    }
    return candidate
  }

  private async writeBlobAtomic(destination: string, bytes: Buffer): Promise<void> {
    await mkdir(this.blobsPath, { recursive: true })
    const temporary = this.containedBlobPath(`.${path.basename(destination)}.${randomUUID()}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(temporary, 'wx', 0o600)
      await file.writeFile(bytes)
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporary, destination)
      await syncDirectory(this.blobsPath)
    } catch (error) {
      await file?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

function validateInput(input: PendingImageInput, bytes: Buffer): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AttachmentVerificationError('Attachment byte size is invalid.')
  }
  if (input.name.trim().length === 0 || input.name.length > 255 || input.name.includes('\0')) {
    throw new AttachmentVerificationError('Attachment name is invalid.')
  }
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    throw new AttachmentVerificationError('Attachment dimensions are invalid.')
  }
}

function inspectImage(bytes: Buffer): {
  mimeType: SupportedImageMimeType
  width: number
  height: number
} {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) {
    throw new AttachmentVerificationError('Attachment bytes are not a supported image.')
  }

  let offset = 8
  let width = 0
  let height = 0
  let sawImageData = false
  let firstChunk = true
  while (offset + 12 <= bytes.length) {
    const dataLength = bytes.readUInt32BE(offset)
    const chunkEnd = offset + 12 + dataLength
    if (chunkEnd > bytes.length) {
      break
    }
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8)
    if (firstChunk) {
      if (chunkType !== 'IHDR' || dataLength !== 13) {
        break
      }
      width = bytes.readUInt32BE(offset + 8)
      height = bytes.readUInt32BE(offset + 12)
      firstChunk = false
    } else if (chunkType === 'IDAT') {
      sawImageData = sawImageData || dataLength > 0
    } else if (chunkType === 'IEND') {
      if (dataLength === 0 && sawImageData && width > 0 && height > 0) {
        return { mimeType: 'image/png', width, height }
      }
      break
    }
    offset = chunkEnd
  }

  throw new AttachmentVerificationError('PNG structure could not be verified.')
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    directory = await open(directoryPath, 'r')
    await directory.sync()
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error
    }
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) {
    throw error
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isUnsupportedDirectorySync(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)
  )
}
