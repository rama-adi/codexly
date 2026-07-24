import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * End-to-end coverage for the overlay's focus behavior. These tests launch the
 * REAL Electron app (built into dist-electron/) and inspect real BrowserWindow
 * state from the main process — something a plain browser or raw Chrome cannot
 * do, because the behavior comes entirely from native window options
 * (`focusable`, `type: 'panel'`) that only exist in Electron.
 *
 * Run with:  pnpm test:e2e   (builds first, then runs Playwright)
 * Or, after a build:  pnpm exec playwright test overlay-focus
 */

let app: ElectronApplication

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['dist-electron/main.js'],
    env: {
      ...process.env,
      // Isolate persisted data so tests never touch the real profile.
      CODEXLY_USER_DATA_DIR: mkdtempSync(join(tmpdir(), 'codexly-e2e-')),
      NODE_ENV: 'test',
    },
  })
  // The homepage is shown on start; wait for its first renderer.
  await app.firstWindow()
})

test.afterEach(async () => {
  await app.close()
})

/** Resolves the renderer Page for a window role (waits for it to exist). */
async function pageForRole(role: 'homepage' | 'overlay'): Promise<Page> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = app.windows().find((page) => page.url().includes(`role=${role}`))
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`No renderer window found for role="${role}"`)
}

/** Reads native window state for a role directly from the main process. */
function windowState(role: 'homepage' | 'overlay') {
  return app.evaluate(({ BrowserWindow }, targetRole) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes(`role=${targetRole}`),
    )
    return win
      ? {
          visible: win.isVisible(),
          focused: win.isFocused(),
          focusable: win.isFocusable(),
          alwaysOnTop: win.isAlwaysOnTop(),
        }
      : null
  }, role)
}

/** Drives the real show/hide path through the exposed desktop bridge. */
async function toggleOverlay(homepage: Page): Promise<void> {
  await homepage.evaluate(() => {
    const bridge = (window as unknown as { codexly?: { v1: { toggleOverlay(): Promise<void> } } }).codexly
    return bridge?.v1.toggleOverlay()
  })
}

test('overlay is created non-focusable so its controls cannot steal key focus', async () => {
  // The core guarantee: a non-focusable window cannot become the key window,
  // so clicking capture / select-area / solve can never pull focus from the
  // app the user is working in.
  const state = await windowState('overlay')
  expect(state).not.toBeNull()
  expect(state?.focusable).toBe(false)
})

test('showing the overlay hides the homepage and stays unfocused', async () => {
  const homepage = await pageForRole('homepage')
  await toggleOverlay(homepage)

  await expect.poll(async () => (await windowState('overlay'))?.visible).toBe(true)

  const overlay = await windowState('overlay')
  expect(overlay?.focusable).toBe(false)
  expect(overlay?.focused).toBe(false)

  // Mutually exclusive surfaces: the homepage must not be visible alongside it.
  expect((await windowState('homepage'))?.visible).toBe(false)
})

test('setOverlayFocusable round-trips through the IPC allowlist', async () => {
  // Directly reproduces the "overlay cannot perform this action" regression:
  // if window.setOverlayFocusable were missing from the overlay allowlist, the
  // bridge call below would reject and fail this test.
  const homepage = await pageForRole('homepage')
  await toggleOverlay(homepage)
  await expect.poll(async () => (await windowState('overlay'))?.visible).toBe(true)

  const overlay = await pageForRole('overlay')
  const setFocusable = (value: boolean) =>
    overlay.evaluate((focusable) => {
      const bridge = (
        window as unknown as {
          codexly?: { v1: { setOverlayFocusable(focusable: boolean): Promise<void> } }
        }
      ).codexly
      return bridge?.v1.setOverlayFocusable(focusable)
    }, value)

  await setFocusable(true)
  await expect.poll(async () => (await windowState('overlay'))?.focusable).toBe(true)

  await setFocusable(false)
  await expect.poll(async () => (await windowState('overlay'))?.focusable).toBe(false)
})

test('dock visibility follows the active surface', async () => {
  test.skip(process.platform !== 'darwin', 'The dock only exists on macOS.')

  const dockVisible = () => app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible() ?? null)

  // Homepage is the active surface at launch → dock icon present.
  await expect.poll(dockVisible).toBe(true)

  const homepage = await pageForRole('homepage')
  await toggleOverlay(homepage)
  await expect.poll(async () => (await windowState('overlay'))?.visible).toBe(true)

  // Overlay is the active surface → dock icon (and menu bar) hidden.
  await expect.poll(dockVisible).toBe(false)
})
