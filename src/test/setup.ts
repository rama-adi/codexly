import { afterEach } from 'vitest'

/**
 * Global setup, wired through `setupFiles` for EVERY test file. The suite mixes
 * node-environment tests (main process, pure shared code) with jsdom ones
 * (`// @vitest-environment jsdom`), so the DOM-only wiring — jest-dom's matchers
 * and Testing Library's between-test unmount — is loaded only when a document
 * actually exists. A node-env file pays nothing for it.
 */
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest')
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)
}
