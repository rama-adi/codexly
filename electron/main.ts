import { app, screen, type Tray } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductController } from './app/product-controller'
import { createCodexlyTray } from './app/tray'
import { registerIpc, type IpcRegistration } from './ipc/register-ipc'
import { DEFAULT_SETTINGS, SettingsStore } from './persistence/settings-store'
import type { Bootstrap } from '../src/shared/schemas/bootstrap'
import type { Capability } from '../src/shared/schemas/capabilities'
import type { WindowState } from '../src/shared/schemas/windows'
import { WindowManager } from './windows/window-manager'
import type { WindowRole } from './windows/window-options'
import type { WindowSnapshot } from './windows/window-state'

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

const windowManager = new WindowManager({
  mainDist,
  rendererDist,
  devServerUrl,
})

let ipcRegistration: IpcRegistration | null = null
let productController: ProductController | null = null
let unsubscribeSnapshots: (() => void) | null = null
let tray: Tray | null = null

app.on('window-all-closed', () => {
  // The process intentionally remains alive for tray-resident operation.
})

app.on('activate', () => {
  windowManager.showHomepage()
})

app.on('before-quit', () => {
  unsubscribeSnapshots?.()
  ipcRegistration?.dispose()
  void productController?.dispose()
  tray?.destroy()
  tray = null
  windowManager.destroy()
})

void app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData')
  const settingsStore = new SettingsStore({ userDataPath })
  productController = await ProductController.create({
    userDataPath,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    windowManager,
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

  tray = createCodexlyTray({
    launchOverlay: () => windowManager.showOverlay(),
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
