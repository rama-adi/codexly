/**
 * Minimal tagged-error idiom for the main process.
 *
 * Errors carry a literal `_tag` so decision logic can switch on the tag
 * exhaustively instead of re-sniffing messages at every call site. String
 * matching stays confined to the one boundary function that produces the tags.
 */

export interface TaggedError<Tag extends string = string> extends Error {
  readonly _tag: Tag
}

export interface TaggedErrorConstructor<Tag extends string> {
  new (message?: string, options?: { cause?: unknown }): TaggedError<Tag>
  readonly tag: Tag
}

/**
 * Builds a base class whose instances expose `_tag`. Subclasses inherit the tag:
 * `class ProviderTimeoutError extends taggedError('ProviderTimeoutError') {}`.
 */
export function taggedError<const Tag extends string>(tag: Tag): TaggedErrorConstructor<Tag> {
  class Tagged extends Error {
    static readonly tag = tag
    readonly _tag: Tag = tag

    constructor(message?: string, options?: { cause?: unknown }) {
      super(message ?? tag, options)
      this.name = tag
    }
  }
  return Tagged
}

/** Narrows an unknown thrown value to a specific tag. */
export function isTagged<Tag extends string>(
  error: unknown,
  tag: Tag,
): error is TaggedError<Tag> {
  return (
    error instanceof Error &&
    (error as { _tag?: unknown })._tag === tag
  )
}

/** Reads the tag of a thrown value, or null when it is not a tagged error. */
export function errorTag(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const tag = (error as { _tag?: unknown })._tag
  return typeof tag === 'string' ? tag : null
}
