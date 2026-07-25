import { errorTag, taggedError } from '../effects/tagged-error'

/** The persisted Codex thread no longer exists on the app-server. */
export class StaleThreadError extends taggedError('StaleThreadError') {}
/** The model rejects 'minimal' reasoning effort while tools are enabled. */
export class MinimalEffortUnsupportedError extends taggedError(
  'MinimalEffortUnsupportedError',
) {}
/** The provider accepted the request but produced no output in time. */
export class ProviderTimeoutError extends taggedError('ProviderTimeoutError') {}
/** Anything else the provider surfaced; carries the original error as its cause. */
export class ProviderRequestError extends taggedError('ProviderRequestError') {}

export type TaggedProviderError =
  | StaleThreadError
  | MinimalEffortUnsupportedError
  | ProviderTimeoutError
  | ProviderRequestError

const PROVIDER_ERROR_TAGS: ReadonlySet<string> = new Set([
  StaleThreadError.tag,
  MinimalEffortUnsupportedError.tag,
  ProviderTimeoutError.tag,
  ProviderRequestError.tag,
])

// Codex has phrased the stale-thread failure differently across releases:
//   "thread '<id>' not found"  (≤0.13x)
//   "no rollout found for thread id <id>"  (0.14x)
const STALE_THREAD_PATTERN =
  /thread ['"]?.+['"]? not found|no rollout found for thread/i
// Two shapes reach us here:
//   "reasoning.effort 'minimal' cannot be used with the web_search tool"
//   "Unsupported value: 'minimal' is not supported with the '<model>' model."
// The second is the model rejecting 'minimal' outright, tools or not.
const MINIMAL_EFFORT_PATTERN =
  /reasoning\.effort ['"]minimal['"]|cannot be used with reasoning\.effort|['"]minimal['"] is not supported/i

/**
 * The single boundary where raw provider failures become tagged errors.
 *
 * Message sniffing is unavoidable — the Codex app-server reports these cases as
 * plain JSON-RPC error strings — but it is confined here so every retry and
 * decision path downstream can switch on `_tag` alone.
 */
export function toTaggedProviderError(error: unknown): TaggedProviderError {
  const tag = errorTag(error)
  if (tag && PROVIDER_ERROR_TAGS.has(tag)) {
    return error as TaggedProviderError
  }
  const message = providerErrorMessage(error)
  const options = { cause: error }
  if (STALE_THREAD_PATTERN.test(message)) {
    return new StaleThreadError(message, options)
  }
  if (MINIMAL_EFFORT_PATTERN.test(message)) {
    return new MinimalEffortUnsupportedError(message, options)
  }
  return new ProviderRequestError(message, options)
}

function providerErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? 'Provider request failed')
}
