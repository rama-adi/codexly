import { BrowserWindow } from 'electron'
import path from 'node:path'

import {
  createHomepageWindowOptions,
  createOverlayWindowOptions,
  createRendererTarget,
  type WindowRole,
} from './window-options'
import {
  transitionOverlayState,
  type OverlayState,
  type OverlayTransition,
  type WindowSnapshot,
} from './window-state'

export const WINDOW_SNAPSHOT_CHANNEL = 'codexly:window:snapshot'

export interface WindowManagerOptions {
  mainDist: string
  rendererDist: string
  devServerUrl?: string
  onSnapshot?: (snapshot: WindowSnapshot) => void
}

export class WindowManager {
  private homepageWindow: BrowserWindow | null = null
  private overlayWindow: BrowserWindow | null = null
  private overlayState: OverlayState = 'hidden'
  private overlayStreaming = false
  private overlayTransitionQueue: Promise<void> = Promise.resolve()
  private readonly loadedWindows = new WeakSet<BrowserWindow>()
  private readonly latestSnapshots = new Map<WindowRole, WindowSnapshot>()
  private destroyed = false

  constructor(private readonly options: WindowManagerOptions) {}

  start(): void {
    this.assertActive()
    this.ensureHomepageWindow()
    this.ensureOverlayWindow()
  }

  getWindow(role: WindowRole): BrowserWindow | null {
    const window = role === 'homepage' ? this.homepageWindow : this.overlayWindow
    return window && !window.isDestroyed() ? window : null
  }

  getSnapshot(role: WindowRole): WindowSnapshot | null {
    const window = this.getWindow(role)
    return window ? this.readSnapshot(role, window) : (this.latestSnapshots.get(role) ?? null)
  }

  showHomepage(): void {
    this.assertActive()
    const window = this.ensureHomepageWindow()

    if (window.isMinimized()) {
      window.restore()
    }

    if (!window.isVisible()) {
      window.show()
    }

    window.focus()
  }

  closeHomepage(): void {
    this.homepageWindow?.close()
  }

  showOverlay(): Promise<void> {
    return this.enqueueOverlayTransition(async () => {
      this.assertActive()
      const window = this.ensureOverlayWindow()

      if (window.isVisible()) {
        this.applyOverlayTransition({ type: 'shown' }, window)
        return
      }

      this.applyOverlayTransition({ type: 'show-requested' }, window)
      window.showInactive()
    })
  }

  hideOverlay(): Promise<void> {
    return this.enqueueOverlayTransition(async () => {
      const window = this.getWindow('overlay')

      if (!window || !window.isVisible()) {
        if (window) {
          this.applyOverlayTransition({ type: 'hidden' }, window)
        }
        return
      }

      this.applyOverlayTransition({ type: 'hide-requested' }, window)
      window.hide()
    })
  }

  setOverlayStreaming(streaming: boolean): Promise<void> {
    return this.enqueueOverlayTransition(async () => {
      if (this.overlayStreaming === streaming) {
        return
      }

      this.overlayStreaming = streaming
      const window = this.getWindow('overlay')
      if (!window) {
        return
      }

      this.applyOverlayTransition(
        { type: streaming ? 'stream-started' : 'stream-stopped' },
        window,
      )
    })
  }

  suspendOverlayCapture(): Promise<void> {
    return this.enqueueOverlayTransition(async () => {
      const window = this.getWindow('overlay')
      if (window) {
        this.applyOverlayTransition({ type: 'capture-suspended' }, window)
      }
    })
  }

  resumeOverlayCapture(): Promise<void> {
    return this.enqueueOverlayTransition(async () => {
      const window = this.getWindow('overlay')
      if (window) {
        this.applyOverlayTransition(
          { type: 'capture-resumed', visible: window.isVisible() },
          window,
        )
      }
    })
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.homepageWindow?.destroy()
    this.overlayWindow?.destroy()
    this.homepageWindow = null
    this.overlayWindow = null
  }

  private ensureHomepageWindow(): BrowserWindow {
    const existingWindow = this.getWindow('homepage')
    if (existingWindow) {
      return existingWindow
    }

    const window = new BrowserWindow(
      createHomepageWindowOptions(this.preloadPath),
    )
    this.homepageWindow = window
    this.configureWindow('homepage', window)
    this.loadRenderer('homepage', window)

    window.on('show', () => {
      this.publishSnapshot('homepage', window)
    })
    window.on('hide', () => {
      this.publishSnapshot('homepage', window)
    })
    window.on('closed', () => {
      if (this.homepageWindow === window) {
        this.homepageWindow = null
      }
      this.rememberDestroyedSnapshot('homepage')
    })

    return window
  }

  private ensureOverlayWindow(): BrowserWindow {
    const existingWindow = this.getWindow('overlay')
    if (existingWindow) {
      return existingWindow
    }

    const window = new BrowserWindow(createOverlayWindowOptions(this.preloadPath))
    this.overlayWindow = window
    this.overlayState = 'hidden'
    this.configureWindow('overlay', window)
    this.configureOverlayProtection(window)
    this.loadRenderer('overlay', window)

    window.on('show', () => {
      this.applyOverlayTransition({ type: 'shown' }, window)
    })
    window.on('hide', () => {
      this.applyOverlayTransition({ type: 'hidden' }, window)
    })
    window.on('closed', () => {
      this.overlayState = transitionOverlayState(
        this.overlayState,
        { type: 'destroyed' },
        this.overlayStreaming,
      )
      if (this.overlayWindow === window) {
        this.overlayWindow = null
      }
      this.rememberDestroyedSnapshot('overlay', this.overlayState)
    })

    return window
  }

  private configureWindow(role: WindowRole, window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    window.webContents.on('will-redirect', (event) => {
      event.preventDefault()
    })
    window.webContents.on('did-finish-load', () => {
      this.loadedWindows.add(window)
      this.publishSnapshot(role, window)
    })

    const publishSnapshot = () => {
      this.publishSnapshot(role, window)
    }
    window.on('focus', publishSnapshot)
    window.on('blur', publishSnapshot)
    window.on('minimize', publishSnapshot)
    window.on('restore', publishSnapshot)
    window.on('maximize', publishSnapshot)
    window.on('unmaximize', publishSnapshot)
    window.on('enter-full-screen', publishSnapshot)
    window.on('leave-full-screen', publishSnapshot)
    window.on('resize', publishSnapshot)
    window.on('move', publishSnapshot)
  }

  private configureOverlayProtection(window: BrowserWindow): void {
    try {
      window.setContentProtection(true)
    } catch {
      // Content protection is best-effort on unsupported window managers.
    }

    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
  }

  private loadRenderer(role: WindowRole, window: BrowserWindow): void {
    const target = createRendererTarget(
      role,
      this.options.devServerUrl,
      path.join(this.options.rendererDist, 'index.html'),
    )

    if (target.url) {
      void window.loadURL(target.url)
      return
    }

    if (target.filePath) {
      void window.loadFile(target.filePath, target.fileOptions)
    }
  }

  private applyOverlayTransition(
    transition: OverlayTransition,
    window: BrowserWindow,
  ): void {
    const nextState = transitionOverlayState(
      this.overlayState,
      transition,
      this.overlayStreaming,
    )

    if (nextState === this.overlayState) {
      return
    }

    this.overlayState = nextState
    this.publishSnapshot('overlay', window)
  }

  private publishSnapshot(role: WindowRole, window: BrowserWindow): void {
    if (window.isDestroyed()) {
      return
    }

    const snapshot = this.readSnapshot(role, window)
    this.latestSnapshots.set(role, snapshot)
    this.options.onSnapshot?.(snapshot)

    if (
      this.loadedWindows.has(window) &&
      !window.webContents.isDestroyed()
    ) {
      window.webContents.send(WINDOW_SNAPSHOT_CHANNEL, snapshot)
    }
  }

  private readSnapshot(role: WindowRole, window: BrowserWindow): WindowSnapshot {
    return {
      role,
      visible: window.isVisible(),
      focused: window.isFocused(),
      minimized: window.isMinimized(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
      destroyed: false,
      bounds: window.getBounds(),
      ...(role === 'overlay' ? { overlayState: this.overlayState } : {}),
    }
  }

  private rememberDestroyedSnapshot(
    role: WindowRole,
    overlayState?: OverlayState,
  ): void {
    const previous = this.latestSnapshots.get(role)
    const snapshot: WindowSnapshot = {
      role,
      visible: false,
      focused: false,
      minimized: false,
      maximized: false,
      fullScreen: false,
      destroyed: true,
      bounds: previous?.bounds ?? null,
      ...(role === 'overlay' ? { overlayState: overlayState ?? 'destroyed' } : {}),
    }
    this.latestSnapshots.set(role, snapshot)
    this.options.onSnapshot?.(snapshot)
  }

  private enqueueOverlayTransition(
    transition: () => Promise<void>,
  ): Promise<void> {
    const queuedTransition = this.overlayTransitionQueue.then(
      transition,
      transition,
    )
    this.overlayTransitionQueue = queuedTransition.catch(() => undefined)
    return queuedTransition
  }

  private get preloadPath(): string {
    return path.join(this.options.mainDist, 'preload.mjs')
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error('WindowManager has been destroyed')
    }
  }
}
