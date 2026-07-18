import { describe, expect, it } from 'vitest'

import { sanitizeThreadTitle, TITLE_FALLBACK } from './thread-title'

describe('sanitizeThreadTitle', () => {
  it('uses the first line and strips wrapping quotes', () => {
    expect(sanitizeThreadTitle('"Fix the auth retry"\nsecond line')).toBe(
      'Fix the auth retry',
    )
  })

  it('collapses whitespace', () => {
    expect(sanitizeThreadTitle('  Refactor   the   parser  ')).toBe(
      'Refactor the parser',
    )
  })

  it('truncates long titles with an ellipsis', () => {
    const title = sanitizeThreadTitle(
      'Please help me debug this really long failing integration test',
    )
    expect(title.length).toBeLessThanOrEqual(28)
    expect(title.endsWith('...')).toBe(true)
  })

  it('falls back for empty input', () => {
    expect(sanitizeThreadTitle('   ')).toBe(TITLE_FALLBACK)
    expect(sanitizeThreadTitle('```')).toBe(TITLE_FALLBACK)
  })
})
