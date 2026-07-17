import { app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WindowManager } from './windows/window-manager'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..')
const mainDist = path.join(appRoot, 'dist-electron')
const rendererDist = path.join(appRoot, 'dist')
const devServerUrl = process.env['VITE_DEV_SERVER_URL']

process.env.APP_ROOT = appRoot
process.env.VITE_PUBLIC = devServerUrl ? path.join(appRoot, 'public') : rendererDist

const windowManager = new WindowManager({
  mainDist,
  rendererDist,
  devServerUrl,
})

app.on('window-all-closed', () => {
  // The process intentionally remains alive for tray-resident operation.
})

app.on('activate', () => {
  windowManager.showHomepage()
})

app.on('before-quit', () => {
  windowManager.destroy()
})

void app.whenReady().then(() => {
  windowManager.start()
})

export { windowManager }
