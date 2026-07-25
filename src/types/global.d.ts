import type { CodexlyDesktopBridge } from './desktop-bridge'

declare global {
  interface Window {
    readonly codexly?: CodexlyDesktopBridge
  }

  /**
   * DEV-ONLY registry the renderer stores publish themselves into, so the browser
   * harness' inspector can report real store + turn-machine state. Only
   * `src/harness/install.ts` ever creates it; the writes in the store factories
   * are `import.meta.env.DEV` guarded, so a production build drops them.
   */
  // eslint-disable-next-line no-var
  var __codexlyDevStores: Map<string, { getState(): unknown }> | undefined

  /** DEV-ONLY browser-harness inspector; see docs/testing.md. */
  // eslint-disable-next-line no-var
  var __codexly: unknown
}

export {}
