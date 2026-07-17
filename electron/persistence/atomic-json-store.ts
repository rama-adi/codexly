import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'])

export type AtomicJsonStoreOptions<T> = Readonly<{
  /** Absolute app.getPath('userData') value injected by the Electron main process. */
  basePath: string
  filename: string
  schema: z.ZodType<T>
}>

/** A small, async-only JSON store with serialized, durable replacement writes. */
export class AtomicJsonStore<T> {
  readonly #schema: z.ZodType<T>
  readonly #directoryPath: string
  readonly #primaryPath: string
  readonly #backupPath: string
  #queue: Promise<void> = Promise.resolve()

  constructor(options: AtomicJsonStoreOptions<T>) {
    if (!path.isAbsolute(options.basePath)) {
      throw new Error('Persistence basePath must be absolute.')
    }
    if (!SAFE_FILENAME.test(options.filename) || options.filename.includes('..')) {
      throw new Error('Persistence filename must be a safe .json basename.')
    }

    this.#schema = options.schema
    this.#directoryPath = path.resolve(options.basePath)
    this.#primaryPath = this.#containedPath(options.filename)
    this.#backupPath = this.#containedPath(`${options.filename}.bak`)
  }

  async read(): Promise<T | null> {
    return this.#enqueue(async () => this.#readWithRecovery())
  }

  async write(value: T): Promise<void> {
    const validated = this.#schema.parse(value)
    return this.#enqueue(async () => {
      await this.#ensureDirectory()
      await this.#backupValidatedPrimary()
      await this.#writeAtomic(this.#primaryPath, this.#encode(validated))
    })
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #readWithRecovery(): Promise<T | null> {
    const primary = await this.#readValidated(this.#primaryPath)
    if (primary.kind === 'valid') {
      return primary.value
    }
    if (primary.kind === 'invalid') {
      await this.#quarantineCorruptPrimary()
    }

    const backup = await this.#readValidated(this.#backupPath)
    if (backup.kind !== 'valid') {
      return null
    }

    await this.#ensureDirectory()
    await this.#writeAtomic(this.#primaryPath, backup.bytes)
    return backup.value
  }

  async #backupValidatedPrimary(): Promise<void> {
    const primary = await this.#readValidated(this.#primaryPath)
    if (primary.kind === 'valid') {
      await this.#writeAtomic(this.#backupPath, primary.bytes)
    }
  }

  async #readValidated(filePath: string): Promise<
    | { kind: 'missing' }
    | { kind: 'invalid' }
    | { kind: 'valid'; value: T; bytes: Buffer }
  > {
    let bytes: Buffer
    try {
      bytes = await readFile(filePath)
    } catch (error) {
      if (isFileNotFound(error)) {
        return { kind: 'missing' }
      }
      throw error
    }

    try {
      return { kind: 'valid', value: this.#schema.parse(JSON.parse(bytes.toString('utf8'))), bytes }
    } catch {
      return { kind: 'invalid' }
    }
  }

  async #quarantineCorruptPrimary(): Promise<void> {
    try {
      await rename(this.#primaryPath, this.#containedPath(`${path.basename(this.#primaryPath)}.corrupt-${randomUUID()}`))
      await this.#syncDirectory()
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error
      }
    }
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directoryPath, { recursive: true })
  }

  async #writeAtomic(destination: string, bytes: Buffer): Promise<void> {
    await this.#ensureDirectory()
    const temporary = this.#containedPath(`.${path.basename(destination)}.${randomUUID()}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(temporary, 'wx', 0o600)
      await file.writeFile(bytes)
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporary, destination)
      await this.#syncDirectory()
    } catch (error) {
      await file?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async #syncDirectory(): Promise<void> {
    let directory: Awaited<ReturnType<typeof open>> | undefined
    try {
      directory = await open(this.#directoryPath, 'r')
      await directory.sync()
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) {
        throw error
      }
    } finally {
      await directory?.close().catch(() => undefined)
    }
  }

  #containedPath(filename: string): string {
    const candidate = path.resolve(this.#directoryPath, filename)
    if (path.relative(this.#directoryPath, candidate).startsWith('..') || path.isAbsolute(path.relative(this.#directoryPath, candidate))) {
      throw new Error('Persistence path escapes its base directory.')
    }
    return candidate
  }

  #encode(value: T): Buffer {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isUnsupportedDirectorySync(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error.code)
  )
}
