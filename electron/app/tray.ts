import { Menu, Tray, nativeImage } from 'electron'

export interface TrayHandlers {
  /** Show the floating overlay (⌘⇧Space). */
  launchOverlay(): void | Promise<void>
  /** Show the homepage window. */
  openHome(): void | Promise<void>
  /** Capture the active display (⇧⌘1). */
  captureDisplay(): void | Promise<void>
  /** Quit the application. */
  quit(): void
}

/**
 * Creates the menu-bar/tray icon that keeps Codexly reachable while its windows
 * are hidden. No icon asset ships with the app, so it falls back to an empty
 * template image plus a macOS menu-bar title, matching the legacy build.
 */
export function createCodexlyTray(handlers: TrayHandlers): Tray {
  const tray = new Tray(trayImage())

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Launch Codexly',
      accelerator: 'CommandOrControl+Shift+Space',
      click: () => {
        void handlers.launchOverlay()
      },
    },
    {
      label: 'Open Codexly Home',
      click: () => {
        void handlers.openHome()
      },
    },
    { type: 'separator' },
    {
      label: 'Take Screenshot (⇧⌘1)',
      click: () => {
        void handlers.captureDisplay()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      accelerator: 'CommandOrControl+Q',
      click: () => {
        handlers.quit()
      },
    },
  ])

  tray.setToolTip('Codexly — Press ⌘⇧Space to launch')
  tray.setContextMenu(contextMenu)

  if (process.platform === 'darwin') {
    tray.setTitle('Codexly')
  }

  tray.on('double-click', () => {
    void handlers.launchOverlay()
  })

  return tray
}

function trayImage(): Electron.NativeImage {
  try {
    const image = nativeImage.createFromBuffer(Buffer.alloc(0))
    return image.isEmpty() ? nativeImage.createEmpty() : image
  } catch {
    return nativeImage.createEmpty()
  }
}
