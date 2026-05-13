import { app, BrowserWindow, Tray, Menu, nativeImage, systemPreferences, dialog, shell, desktopCapturer } from "electron"
import { initializeIpcHandlers } from "./ipc/handlers"
import { WindowHelper } from "./shell/WindowHelper"
import { ScreenshotCaptureMode, ScreenshotHelper } from "./shell/ScreenshotHelper"
import { ShortcutsHelper } from "./shell/shortcuts"
import { CodexReadyStatus, ProcessingHelper } from "./services/ProcessingHelper"
import { getAppSettings, updateAppSettings } from "./stores/AppSettings"
import { listChatSessions } from "./stores/HistoryStore"

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  private screenshotHelper: ScreenshotHelper
  public shortcutsHelper: ShortcutsHelper
  public processingHelper: ProcessingHelper
  private tray: Tray | null = null

  // View management
  private view: "queue" | "solutions" = "queue"

  private problemInfo: {
    problem_statement: string
    input_format: Record<string, any>
    output_format: Record<string, any>
    constraints: Array<Record<string, any>>
    test_cases: Array<Record<string, any>>
  } | null = null // Allow null

  private hasContinuedSession: boolean = false

  // Processing events
  public readonly PROCESSING_EVENTS = {
    //global states
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",

    //states for generating the initial solution
    INITIAL_START: "initial-start",
    INITIAL_SOLUTION_ERROR: "solution-error",
    SOLUTION_STREAM_START: "solution-stream-start",
    SOLUTION_STREAM_DELTA: "solution-stream-delta",
    SOLUTION_STREAM_COMPLETE: "solution-stream-complete",
    SOLUTION_STREAM_ERROR: "solution-stream-error",

  } as const

  constructor() {
    // Initialize WindowHelper with this
    this.windowHelper = new WindowHelper(this)

    // Initialize ScreenshotHelper
    this.screenshotHelper = new ScreenshotHelper(this.view)

    // Initialize ProcessingHelper
    this.processingHelper = new ProcessingHelper(this)

    // Initialize ShortcutsHelper
    this.shortcutsHelper = new ShortcutsHelper(this)
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // Getters and Setters
  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(problemInfo: any): void {
    this.problemInfo = problemInfo
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  // Window management methods
  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
    this.shortcutsHelper.setToolbarShortcutsEnabled(false)
  }

  public showMainWindow(): void {
    this.windowHelper.showMainWindow()
    this.shortcutsHelper.setToolbarShortcutsEnabled(true)
  }

  public openSettingsWindow(): void {
    this.windowHelper.openSettingsWindow()
  }

  public closeSettingsWindow(): void {
    this.windowHelper.closeSettingsWindow()
  }

  public minimizeSettingsWindow(): void {
    this.windowHelper.minimizeSettingsWindow()
  }

  public getStealthEnabled(): boolean {
    return getAppSettings().stealthEnabled
  }

  public setStealthEnabled(enabled: boolean): { stealthEnabled: boolean } {
    const settings = updateAppSettings({ stealthEnabled: enabled })
    const mainWindow = this.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(settings.stealthEnabled)
      if (!settings.stealthEnabled) {
        mainWindow.setOpacity(1)
        mainWindow.setIgnoreMouseEvents(false)
      }
    }
    return { stealthEnabled: settings.stealthEnabled }
  }

  public quitApp(): void {
    this.tray?.destroy()
    this.tray = null

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.destroy()
      }
    }

    app.quit()
    setTimeout(() => app.exit(0), 100)
  }

  public toggleMainWindow(): void {
    console.log(
      "Screenshots: ",
      this.screenshotHelper.getScreenshotQueue().length,
      "Extra screenshots: ",
      this.screenshotHelper.getExtraScreenshotQueue().length
    )
    this.windowHelper.toggleMainWindow()
    this.shortcutsHelper.setToolbarShortcutsEnabled(this.windowHelper.isVisible())
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()
    this.processingHelper.getLLMHelper().clearChatHistory()

    // Clear problem info
    this.problemInfo = null

    // Reset view to initial state
    this.setView("queue")
  }

  // Screenshot management methods
  public async takeScreenshot(
    mode: ScreenshotCaptureMode = "fullscreen"
  ): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const screenshotPath = await this.screenshotHelper.takeScreenshot(
      () => this.hideMainWindow(),
      () => this.showMainWindow(),
      mode
    )

    return screenshotPath
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(path)
  }

  // New methods to move the window
  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }
  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }
  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
    this.shortcutsHelper.setToolbarShortcutsEnabled(true)
  }

  public async startToolbarSession(): Promise<CodexReadyStatus> {
    this.getScreenshotHelper().clearQueues()
    this.setView("queue")
    this.processingHelper.resetSession()
    await this.processingHelper.prepareForLaunch()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("screenshots-cleared")
      window.webContents.send("history-changed", listChatSessions())
      window.webContents.send("reset-view")
    }
    this.showMainWindow()
    return this.processingHelper.getReadyStatus()
  }

  public createTray(): void {
    // Create a simple tray icon
    const image = nativeImage.createEmpty()
    
    // Try to use a system template image for better integration
    let trayImage = image
    try {
      // Create a minimal icon - just use an empty image and set the title
      trayImage = nativeImage.createFromBuffer(Buffer.alloc(0))
    } catch (error) {
      console.log("Using empty tray image")
      trayImage = nativeImage.createEmpty()
    }
    
    this.tray = new Tray(trayImage)
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Launch Codexly',
        accelerator: 'CommandOrControl+Shift+Space',
        click: async () => {
          try {
            await this.startToolbarSession()
          } catch (error) {
            console.error("Error launching toolbar from tray:", error)
          }
        }
      },
      {
        label: 'Settings',
        click: () => {
          this.openSettingsWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Take Screenshot (Cmd+H)',
        click: async () => {
          try {
            const screenshotPath = await this.takeScreenshot()
            const preview = await this.getImagePreview(screenshotPath)
            const mainWindow = this.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send("screenshot-taken", {
                path: screenshotPath,
                preview
              })
            }
          } catch (error) {
            console.error("Error taking screenshot from tray:", error)
          }
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => {
          this.quitApp()
        }
      }
    ])
    
    this.tray.setToolTip('Codexly - Press Cmd+Shift+Space to launch')
    this.tray.setContextMenu(contextMenu)
    
    // Set a title for macOS (will appear in menu bar)
    if (process.platform === 'darwin') {
      this.tray.setTitle('Codexly')
    }
    
    // Double-click to show window
    this.tray.on('double-click', async () => {
      try {
        await this.startToolbarSession()
      } catch (error) {
        console.error("Error launching toolbar from tray:", error)
      }
    })
  }

  public setHasContinuedSession(value: boolean): void {
    this.hasContinuedSession = value
  }

  public getHasContinuedSession(): boolean {
    return this.hasContinuedSession
  }
}

async function ensureScreenCaptureAccess() {
  if (process.platform !== "darwin") return

  const status = systemPreferences.getMediaAccessStatus("screen")
  if (status === "granted") return

  // Touching desktopCapturer triggers the macOS TCC prompt the first time.
  try {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
  } catch {}

  if (systemPreferences.getMediaAccessStatus("screen") === "granted") return

  const response = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Open System Settings", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Screen Recording permission required",
    message: "Codexly needs Screen Recording access to capture screenshots.",
    detail: "Enable it under Privacy & Security → Screen Recording, then quit and relaunch the app.",
  })
  if (response === 0) {
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
  }
}

// Application initialization
async function initializeApp() {
  const appState = AppState.getInstance()

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  app.whenReady().then(async () => {
    console.log("App is ready")
    await ensureScreenCaptureAccess()
    appState.createWindow()
    appState.processingHelper.prepareForLaunch().catch(error => {
      console.warn("Codex prelaunch failed:", error)
    })
    appState.openSettingsWindow()
    appState.createTray()
    // Register global shortcuts using ShortcutsHelper
    appState.shortcutsHelper.registerGlobalShortcuts()
  })

  app.on("activate", () => {
    console.log("App activated")
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    }
  })

  // Quit when all windows are closed, except on macOS
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  app.dock?.hide() // Hide dock icon (optional)
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}

// Start the application
initializeApp().catch(console.error)
