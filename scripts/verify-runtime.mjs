import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'codexly-verify-'))
const app = await electron.launch({
  args: [projectRoot],
  env: { ...process.env, CODEXLY_USER_DATA_DIR: userDataPath },
})

try {
  await app.evaluate(async ({ BrowserWindow }) => {
    const deadline = Date.now() + 10_000
    while (
      BrowserWindow.getAllWindows().length < 2 ||
      BrowserWindow.getAllWindows().some(
        (window) => !window.webContents.getURL().includes('role='),
      )
    ) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the homepage and overlay windows')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })

  const pages = app.windows()
  const pageDetails = pages.map((page) => ({
    page,
    role: new URL(page.url()).searchParams.get('role'),
  }))
  const homepage = pageDetails.find((entry) => entry.role === 'homepage')?.page
  const overlay = pageDetails.find((entry) => entry.role === 'overlay')?.page

  if (!homepage || !overlay) {
    throw new Error('Homepage or overlay renderer is missing')
  }

  await homepage.waitForLoadState('domcontentloaded')
  await overlay.waitForLoadState('domcontentloaded')

  const windowsBefore = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      visible: window.isVisible(),
      destroyed: window.isDestroyed(),
      alwaysOnTop: window.isAlwaysOnTop(),
    })),
  )

  const homepageSecurity = await homepage.evaluate(() => ({
    bridgeKeys: Object.keys(window.codexly ?? {}),
    v1Keys: Object.keys(window.codexly?.v1 ?? {}).sort(),
    hasRequire: typeof globalThis.require !== 'undefined',
    hasProcess: typeof globalThis.process !== 'undefined',
    hasElectron: typeof globalThis.electron !== 'undefined',
  }))
  const overlaySecurity = await overlay.evaluate(() => ({
    bridgeKeys: Object.keys(window.codexly ?? {}),
    v1Keys: Object.keys(window.codexly?.v1 ?? {}).sort(),
    hasRequire: typeof globalThis.require !== 'undefined',
    hasProcess: typeof globalThis.process !== 'undefined',
  }))

  const bootstrap = await homepage.evaluate(() => window.codexly.v1.bootstrap())
  const runtimeStatus = await homepage.evaluate(() => window.codexly.v1.runtimeStatus())
  await homepage.getByText('Good to see you.').waitFor()
  const popupDenied = await homepage.evaluate(
    () => window.open('https://example.com') === null,
  )
  const urlBeforeNavigation = homepage.url()
  await homepage.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const urlAfterNavigation = homepage.url()

  await homepage.screenshot({ path: 'runtime-verification-homepage.png' })
  await homepage.evaluate(() => window.codexly.v1.toggleOverlay())
  await app.evaluate(async ({ BrowserWindow }) => {
    const overlayWindow = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('role=overlay'),
    )
    if (!overlayWindow) throw new Error('Overlay window is missing')
    const deadline = Date.now() + 5_000
    while (!overlayWindow.isVisible()) {
      if (Date.now() > deadline) throw new Error('Overlay did not become visible')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })
  let captureProbe = 'not-run'
  try {
    await overlay.getByRole('button', { name: /Capture/ }).click()
    await overlay.locator('img[alt^="Screenshot"]').first().waitFor({ timeout: 15_000 })
    captureProbe = 'captured'
  } catch (error) {
    captureProbe = `blocked: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
  }
  await overlay.screenshot({ path: 'runtime-verification-overlay.png' })
  const overlayText = await overlay.locator('body').innerText()
  await homepage.evaluate(() => window.codexly.v1.toggleOverlay())
  await homepage.close()
  await new Promise((resolve) => setTimeout(resolve, 500))

  const windowsAfterHomepageClose = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      visible: window.isVisible(),
      destroyed: window.isDestroyed(),
    })),
  )

  console.log(
    JSON.stringify(
      {
        windowsBefore,
        homepageSecurity,
        overlaySecurity,
        runtimeStatus,
        overlayText,
        captureProbe,
        bootstrap: {
          version: bootstrap.version,
          windowRoles: bootstrap.windows.map((window) => window.role),
          authState: bootstrap.auth.state,
          capabilityCount: bootstrap.capabilities.items.length,
        },
        popupDenied,
        navigationDenied: urlBeforeNavigation === urlAfterNavigation,
        urlBeforeNavigation,
        urlAfterNavigation,
        windowsAfterHomepageClose,
      },
      null,
      2,
    ),
  )
} finally {
  await app.close()
  await rm(userDataPath, { recursive: true, force: true })
}
