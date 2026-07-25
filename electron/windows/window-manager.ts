import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'

import { logger } from '../shared/logger'

import {
  createHomepageWindowOptions,
  createOverlayWindowOptions,
  createRendererTarget,
  WINDOW_ROLES,
  type WindowRole,
} from './window-options'
import {
  transitionOverlayState,
  type OverlayState,
  type OverlayTransition,
  type WindowSnapshot,
} from './window-state'

type WindowBounds = Readonly<{ x: number; y: number; width: number; height: number }>

/**
 * Every window capability this process uses, stated structurally. A real
 * BrowserWindow satisfies it; so does a plain object in a node test.
 */
export interface ManagedWindow {
  readonly webContents: {
    readonly id: number
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(
      event: 'will-navigate' | 'will-redirect',
      listener: (event: { preventDefault(): void }) => void,
    ): void
    on(event: 'did-finish-load', listener: () => void): void
    setBackgroundThrottling(enabled: boolean): void
  }
  on(event: string, listener: () => void): void
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  getBounds(): WindowBounds
  setBounds(bounds: WindowBounds): void
  getContentSize(): number[]
  setContentSize(width: number, height: number): void
  setIgnoreMouseEvents(ignore: boolean): void
  setFocusable(focusable: boolean): void
  setContentProtection(enabled: boolean): void
  setSkipTaskbar(skip: boolean): void
  setVisibleOnAllWorkspaces(flag: boolean, options: { visibleOnFullScreen: boolean }): void
  setHiddenInMissionControl(hidden: boolean): void
  setAlwaysOnTop(flag: boolean, level: 'screen-saver', relativeLevel: number): void
  restore(): void
  show(): void
  showInactive(): void
  hide(): void
  focus(): void
  blur(): void
  close(): void
  destroy(): void
  loadURL(url: string): Promise<unknown>
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<unknown>
}

/** The host-application surface the manager drives (activation policy / dock). */
export interface WindowHostAdapter {
  readonly platform: string
  setActivationPolicy(policy: 'regular' | 'accessory'): void
}

export interface WindowManagerOptions {
  mainDist: string
  rendererDist: string
  devServerUrl?: string
  /** Invoked when the user closes the homepage window (not on teardown). */
  onHomepageClosed?: () => void
  /** Window construction seam; defaults to a real BrowserWindow. */
  createWindow?(options: BrowserWindowConstructorOptions): ManagedWindow
  /** Host-application seam; defaults to the real Electron app. */
  host?: WindowHostAdapter
}

const createRealWindow = (options: BrowserWindowConstructorOptions): ManagedWindow =>
  new BrowserWindow(options)

const realHost: WindowHostAdapter = {
  get platform() {
    return process.platform
  },
  setActivationPolicy: (policy) => app.setActivationPolicy(policy),
}

const log = logger.child('windows')

export class WindowManager {
  private readonly createWindow: NonNullable<WindowManagerOptions['createWindow']>
  private readonly host: WindowHostAdapter
  private homepageWindow: ManagedWindow | null = null
  private overlayWindow: ManagedWindow | null = null
  private overlayContentProtection = true
  private overlayState: OverlayState = 'hidden'
  private overlayStreaming = false
  private overlayTransitionQueue: Promise<void> = Promise.resolve()
  /** Tracks the last-applied dock/menu-bar (activation policy) state on macOS. */
  private dockVisible: boolean | null = null
  private readonly latestSnapshots = new Map<WindowRole, WindowSnapshot>()
  private readonly snapshotListeners = new Set<(snapshot: WindowSnapshot) => void>()
  private destroyed = false

  constructor(private readonly options: WindowManagerOptions) {
    this.createWindow = options.createWindow ?? createRealWindow
    this.host = options.host ?? realHost
  }

  start(): void {
    this.assertActive()
    this.ensureHomepageWindow()
    this.ensureOverlayWindow()
    // The homepage is the initial surface, so the dock icon belongs on screen
    // from launch. Set it explicitly rather than relying on the OS default,
    // which is not guaranteed to match the surface we actually show first.
    this.setDockVisible(true)
  }

  getWindow(role: WindowRole): ManagedWindow | null {
    const window = role === 'homepage' ? this.homepageWindow : this.overlayWindow
    return window && !window.isDestroyed() ? window : null
  }

  getSnapshot(role: WindowRole): WindowSnapshot | null {
    const window = this.getWindow(role)
    return window ? this.readSnapshot(role, window) : (this.latestSnapshots.get(role) ?? null)
  }

  getRoleForWebContentsId(webContentsId: number): WindowRole | null {
    for (const role of WINDOW_ROLES) {
      const window = this.getWindow(role)
      if (window?.webContents.id === webContentsId) {
        return role
      }
    }
    return null
  }

  subscribeToSnapshots(listener: (snapshot: WindowSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  showHomepage(): void {
    this.assertActive()
    const window = this.ensureHomepageWindow()
    log.info('showHomepage', {
      wasVisible: window.isVisible(),
      overlayVisible: this.getWindow('overlay')?.isVisible() ?? false,
    })

    // The homepage and the overlay are mutually exclusive surfaces: revealing
    // one always dismisses the other so they can never be displayed together.
    void this.hideOverlay()

    // The homepage is a normal app window, so the dock icon belongs on screen
    // while it is the active surface.
    this.setDockVisible(true)

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
      log.info('showOverlay', {
        wasVisible: window.isVisible(),
        state: this.overlayState,
        homepageVisible: this.getWindow('homepage')?.isVisible() ?? false,
      })

      // Mutually exclusive with the homepage; hide it before revealing the HUD.
      const homepage = this.getWindow('homepage')
      if (homepage?.isVisible()) {
        homepage.hide()
      }

      // The overlay is a floating HUD, not a regular app: drop the dock icon
      // (and the menu bar) while it is the active surface so it reads as an
      // accessory rather than a windowed application.
      this.setDockVisible(false)

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
      log.info('hideOverlay', {
        exists: Boolean(window),
        wasVisible: window?.isVisible() ?? false,
        wasFocused: window?.isFocused() ?? false,
        state: this.overlayState,
      })

      if (!window || !window.isVisible()) {
        if (window) {
          this.applyOverlayTransition({ type: 'hidden' }, window)
        }
        return
      }

      this.applyOverlayTransition({ type: 'hide-requested' }, window)
      // A focusable macOS panel can become the key window after the user types
      // into it even though it was initially shown with showInactive(). Yield
      // that key focus before hiding so the previously used app becomes key
      // again instead of being left with an inactive-looking title bar.
      if (window.isFocused()) {
        window.blur()
      }
      window.hide()
    })
  }

  releaseOverlayFocus(): void {
    const window = this.getWindow('overlay')
    if (window?.isFocused()) {
      window.blur()
    }
  }

  /**
   * Toggles whether the overlay can become the key window. It stays
   * non-focusable so its controls never pull focus from the user's frontmost
   * app; the renderer flips this on only while the chat view needs keyboard
   * input, and off again (yielding key focus) once that view closes.
   */
  setOverlayFocusable(focusable: boolean): void {
    const window = this.getWindow('overlay')
    log.debug('setOverlayFocusable', {
      focusable,
      exists: Boolean(window),
      visible: window?.isVisible() ?? false,
      wasFocused: window?.isFocused() ?? false,
    })
    if (!window) {
      return
    }
    window.setFocusable(focusable)
    if (focusable) {
      window.focus()
    } else if (window.isFocused()) {
      window.blur()
    }
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
    this.snapshotListeners.clear()
  }

  private ensureHomepageWindow(): ManagedWindow {
    const existingWindow = this.getWindow('homepage')
    if (existingWindow) {
      return existingWindow
    }

    const window = this.createWindow(createHomepageWindowOptions(this.preloadPath))
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
      if (!this.destroyed) {
        this.options.onHomepageClosed?.()
      }
    })

    return window
  }

  private ensureOverlayWindow(): ManagedWindow {
    const existingWindow = this.getWindow('overlay')
    if (existingWindow) {
      return existingWindow
    }

    const window = this.createWindow(createOverlayWindowOptions(this.preloadPath))
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

  private configureWindow(role: WindowRole, window: ManagedWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    window.webContents.on('will-redirect', (event) => {
      event.preventDefault()
    })
    window.webContents.on('did-finish-load', () => {
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

  /**
   * Applies the stealth (content protection) preference to the live overlay and
   * remembers it for windows created later. When enabled the overlay is excluded
   * from screen capture and recordings.
   */
  setOverlayContentProtection(enabled: boolean): void {
    this.overlayContentProtection = enabled
    const window = this.getWindow('overlay')
    if (!window) {
      return
    }
    try {
      window.setContentProtection(enabled)
    } catch {
      // Content protection is best-effort on unsupported window managers.
    }
  }

  private configureOverlayProtection(window: ManagedWindow): void {
    try {
      window.setContentProtection(this.overlayContentProtection)
    } catch {
      // Content protection is best-effort on unsupported window managers.
    }

    window.setSkipTaskbar(true)
    window.webContents.setBackgroundThrottling(false)

    if (this.host.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      window.setHiddenInMissionControl(true)
      window.setAlwaysOnTop(true, 'screen-saver', 1)
    }
  }

  private loadRenderer(role: WindowRole, window: ManagedWindow): void {
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
    window: ManagedWindow,
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

  private publishSnapshot(role: WindowRole, window: ManagedWindow): void {
    if (window.isDestroyed()) {
      return
    }

    const snapshot = this.readSnapshot(role, window)
    const previous = this.latestSnapshots.get(role)
    if (previous && snapshotsEqual(previous, snapshot)) {
      return
    }
    this.latestSnapshots.set(role, snapshot)
    for (const listener of this.snapshotListeners) {
      listener(snapshot)
    }
  }

  private readSnapshot(role: WindowRole, window: ManagedWindow): WindowSnapshot {
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
    for (const listener of this.snapshotListeners) {
      listener(snapshot)
    }
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

  /**
   * Shows or hides the macOS dock icon (and, with it, the menu bar) by switching
   * the app's activation policy: `regular` for the homepage's normal windowed
   * presence, `accessory` for the floating overlay HUD. This uses
   * `setActivationPolicy` rather than `app.dock.hide()`, which is unreliable
   * (it does not actually hide the icon on current macOS/Electron). No-op off
   * macOS, where there is no dock or activation policy.
   */
  private setDockVisible(visible: boolean): void {
    if (this.host.platform !== 'darwin') {
      return
    }
    if (this.dockVisible === visible) {
      return
    }
    this.dockVisible = visible
    const policy = visible ? 'regular' : 'accessory'
    log.info('setDockVisible', { visible, policy })
    this.host.setActivationPolicy(policy)
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

function snapshotsEqual(left: WindowSnapshot, right: WindowSnapshot): boolean {
  const leftBounds = left.bounds
  const rightBounds = right.bounds
  return (
    left.role === right.role &&
    left.visible === right.visible &&
    left.focused === right.focused &&
    left.minimized === right.minimized &&
    left.maximized === right.maximized &&
    left.fullScreen === right.fullScreen &&
    left.destroyed === right.destroyed &&
    left.overlayState === right.overlayState &&
    leftBounds?.x === rightBounds?.x &&
    leftBounds?.y === rightBounds?.y &&
    leftBounds?.width === rightBounds?.width &&
    leftBounds?.height === rightBounds?.height
  )
}
