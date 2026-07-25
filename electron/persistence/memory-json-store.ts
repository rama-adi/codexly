import type { z } from 'zod'

/**
 * The read/write surface {@link AtomicJsonStore} exposes. Collaborators depend
 * on this instead of the class so a test can hand them an in-memory document.
 */
export interface JsonDocumentStore<T> {
  read(): Promise<T | null>
  write(value: T): Promise<void>
}

export type MemoryJsonStoreOptions<T> = Readonly<{
  schema: z.ZodType<T>
  initial?: T | null
  /** Fault seam: throws here surface exactly as a disk failure would. */
  beforeWrite?: (value: T) => void | Promise<void>
  beforeRead?: () => void | Promise<void>
}>

/**
 * An AtomicJsonStore-compatible document that never touches the filesystem. It
 * keeps the class' observable contract — schema validation on write, `null` for
 * an absent document, serialized operations — so a fast test exercises the same
 * code paths the real store does.
 */
export class MemoryJsonStore<T> implements JsonDocumentStore<T> {
  readonly #schema: z.ZodType<T>
  readonly #beforeWrite?: MemoryJsonStoreOptions<T>['beforeWrite']
  readonly #beforeRead?: MemoryJsonStoreOptions<T>['beforeRead']
  #document: string | null
  #queue: Promise<void> = Promise.resolve()

  constructor(options: MemoryJsonStoreOptions<T>) {
    this.#schema = options.schema
    this.#beforeWrite = options.beforeWrite
    this.#beforeRead = options.beforeRead
    this.#document =
      options.initial === undefined || options.initial === null
        ? null
        : JSON.stringify(options.schema.parse(options.initial))
  }

  read(): Promise<T | null> {
    return this.#enqueue(async () => {
      await this.#beforeRead?.()
      if (this.#document === null) return null
      const parsed = this.#schema.safeParse(JSON.parse(this.#document))
      return parsed.success ? parsed.data : null
    })
  }

  write(value: T): Promise<void> {
    const validated = this.#schema.parse(value)
    return this.#enqueue(async () => {
      await this.#beforeWrite?.(validated)
      // Stored as text so callers cannot mutate the document through the value
      // they passed in, matching what a real on-disk round trip guarantees.
      this.#document = JSON.stringify(validated)
    })
  }

  #enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(
      (): void => undefined,
      (): void => undefined,
    )
    return result
  }
}
