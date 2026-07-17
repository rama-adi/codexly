import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(__dirname, '..')
const mainDist = path.join(appRoot, 'dist-electron')
const rendererDist = path.join(appRoot, 'dist')
const devServerUrl = process.env['VITE_DEV_SERVER_URL']

process.env.APP_ROOT = appRoot
process.env.VITE_PUBLIC = devServerUrl ? path.join(appRoot, 'public') : rendererDist

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(mainDist, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(path.join(rendererDist, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

void app.whenReady().then(createWindow)
