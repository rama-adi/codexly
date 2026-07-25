import { app, Menu, screen, type Tray } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createElectronAdapters, registerAdapterTeardown } from './app/adapters'
import { ProductController } from './app/product-controller'
import { createCodexlyTray } from './app/tray'
import { registerIpc, type IpcRegistration } from './ipc/register-ipc'
import { DEFAULT_SETTINGS, SettingsStore } from './persistence/settings-store'
import type { Bootstrap } from '../src/shared/schemas/bootstrap'
import type { Capability } from '../src/shared/schemas/capabilities'
import type { WindowState } from '../src/shared/schemas/windows'
import { logger } from './shared/logger'
import { WindowManager } from './windows/window-manager'
import type { WindowRole } from './windows/window-options'
import type { WindowSnapshot } from './windows/window-state'

const log = logger.child('main')

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception in main process', error)
})
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection in main process', reason)
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..')
const mainDist = path.join(appRoot, 'dist-electron')
const rendererDist = path.join(appRoot, 'dist')
const devServerUrl = process.env['VITE_DEV_SERVER_URL']

process.env.APP_ROOT = appRoot
process.env.VITE_PUBLIC = devServerUrl ? path.join(appRoot, 'public') : rendererDist
if (process.env['CODEXLY_USER_DATA_DIR']) {
  app.setPath('userData', process.env['CODEXLY_USER_DATA_DIR'])
}

const adapters = createElectronAdapters()
registerAdapterTeardown(adapters)

const windowManager = new WindowManager({
  mainDist,
  rendererDist,
  devServerUrl,
  // Closing the main window exits the whole app (old-app behavior); the tray
  // alone is not a reason to keep running once the user dismisses the app.
  onHomepageClosed: () => app.quit(),
})

let ipcRegistration: IpcRegistration | null = null
let productController: ProductController | null = null
let unsubscribeSnapshots: (() => void) | null = null
let tray: Tray | null = null

app.on('window-all-closed', () => {
  // The process intentionally remains alive for tray-resident operation.
})

app.on('activate', () => {
  // macOS fires "activate" whenever the app comes to the foreground — including
  // side effects of overlay actions (screen capture, the HUD taking keyboard
  // focus). Surfacing the homepage here would break overlay/homepage
  // exclusivity by popping settings on top of an active overlay, so only reveal
  // the homepage when the overlay is not already the visible surface.
  const overlayVisible = windowManager.getWindow('overlay')?.isVisible() ?? false
  log.info('app.activate', { overlayVisible })
  if (overlayVisible) return
  windowManager.showHomepage()
})

let quitting = false

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  // Hold the quit until subsystems tear down (notably the Codex child
  // process), but never longer than a short deadline.
  event.preventDefault()
  unsubscribeSnapshots?.()
  ipcRegistration?.dispose()
  tray?.destroy()
  tray = null
  const dispose = productController?.dispose() ?? Promise.resolve()
  const deadline = new Promise((resolve) => setTimeout(resolve, 3000))
  void Promise.race([dispose.catch(() => undefined), deadline]).finally(() => {
    windowManager.destroy()
    app.exit(0)
  })
})

void app.whenReady().then(async () => {
  log.info('App ready — bootstrapping', { platform: process.platform, packaged: app.isPackaged })
  // No application menu: the app is driven entirely by the overlay HUD, the
  // homepage window, and the tray. This removes the default Electron menu bar.
  Menu.setApplicationMenu(null)
  const userDataPath = app.getPath('userData')
  const settingsStore = new SettingsStore({ userDataPath })
  productController = await ProductController.create({
    userDataPath,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    windowManager,
    adapters,
    publish: (event, roles) => ipcRegistration?.publishProduct(event, roles),
  })
  ipcRegistration = registerIpc({
    rendererFilePath: path.join(rendererDist, 'index.html'),
    devServerUrl,
    resolveWindowRole: (webContentsId) =>
      windowManager.getRoleForWebContentsId(webContentsId),
    getBootstrap: async (role) => createBootstrap(settingsStore, role),
    handleProduct: (command, role) => productController!.handle(command, role),
  })
  unsubscribeSnapshots = windowManager.subscribeToSnapshots((snapshot) => {
    const window = toContractWindow(snapshot)
    if (window) {
      ipcRegistration?.publish({ type: 'window.changed', window })
    }
  })
  windowManager.start()
  log.info('Bootstrap complete — windows started')

  tray = createCodexlyTray({
    launchOverlay: () => productController?.openOverlay() ?? windowManager.showOverlay(),
    openHome: () => windowManager.showHomepage(),
    captureDisplay: () => productController?.captureActiveDisplay(),
    quit: () => app.quit(),
  })
})

async function createBootstrap(
  settingsStore: SettingsStore,
  requesterRole: WindowRole,
): Promise<Bootstrap> {
  const storedSettings =
    requesterRole === 'homepage' ? await settingsStore.load() : DEFAULT_SETTINGS
  const generatedAt = new Date().toISOString()
  const windows = (['homepage', 'overlay'] as const)
    .map((role) => windowManager.getSnapshot(role))
    .filter((snapshot): snapshot is WindowSnapshot => snapshot !== null)
    .map(toContractWindow)
    .filter((window): window is WindowState => window !== null)
    .filter(
      (window) => requesterRole === 'homepage' || window.role === 'toolbar',
    )

  return {
    version: 1,
    generatedAt,
    settings: storedSettings,
    auth: {
      version: 1,
      state: 'unauthenticated',
      reason: 'signed_out',
    },
    capabilities: {
      version: 1,
      platform: getSupportedPlatform(),
      evaluatedAt: generatedAt,
      items: createCapabilities(),
    },
    windows,
    conversations: [],
    sessions: [],
  }
}

function getSupportedPlatform(): 'darwin' | 'linux' | 'win32' {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? process.platform
    : 'linux'
}

function createCapabilities(): Capability[] {
  const unavailable = (
    name: Capability['name'],
    detail: string,
  ): Capability => ({
    name,
    available: false,
    reason: 'unavailable',
    detail,
  })

  return [
    unavailable('codex', 'The Codex runtime is not connected.'),
    unavailable('filesystem', 'Filesystem access is not enabled.'),
    unavailable('globalShortcuts', 'Global shortcuts are not registered.'),
    unavailable('microphone', 'Microphone capture is not enabled.'),
    unavailable('notifications', 'Notifications are not enabled.'),
    unavailable('screenshots', 'Screenshot capture is not enabled.'),
    unavailable('systemAudio', 'System audio capture is not enabled.'),
    unavailable('updater', 'The updater is not configured.'),
    unavailable('windowControls', 'Window control commands are not exposed.'),
  ]
}

function toContractWindow(snapshot: WindowSnapshot): WindowState | null {
  if (!snapshot.bounds) {
    return null
  }

  const display = screen.getDisplayMatching(snapshot.bounds)
  return {
    version: 1,
    role: snapshot.role === 'homepage' ? 'main' : 'toolbar',
    displayId: String(display.id),
    bounds: snapshot.bounds,
    visible: snapshot.visible,
    focused: snapshot.focused,
    minimized: snapshot.minimized,
    maximized: snapshot.maximized,
    fullScreen: snapshot.fullScreen,
    alwaysOnTop: snapshot.role === 'overlay',
    updatedAt: new Date().toISOString(),
  }
}

export { windowManager }
