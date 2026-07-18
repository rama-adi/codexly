export const TITLE_FALLBACK = 'New session'
const TITLE_MAX_LENGTH = 28

/**
 * Derives a short, human-friendly session title from a user message. Ported
 * from the legacy ThreadTitleHelper: take the first line, strip surrounding
 * quotes/backticks, collapse whitespace, and clamp to 28 characters. No model
 * call is involved.
 */
export function sanitizeThreadTitle(raw: string): string {
  const normalized =
    raw
      .trim()
      .split(/\r?\n/g)[0]
      ?.trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .trim()
      .replace(/\s+/g, ' ') ?? ''

  if (!normalized) {
    return TITLE_FALLBACK
  }
  if (normalized.length <= TITLE_MAX_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`
}
