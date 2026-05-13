// ScreenshotHelper.ts

import path from "node:path"
import fs from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { app, BrowserWindow, screen } from "electron"
import { v4 as uuidv4 } from "uuid"
import sharp from "sharp"

const execFileP = promisify(execFile)

export type ScreenshotCaptureMode = "fullscreen" | "selection"

export class ScreenshotCanceledError extends Error {
  constructor() {
    super("Screenshot canceled")
    this.name = "ScreenshotCanceledError"
  }
}

type CaptureBounds = {
  x: number
  y: number
  width: number
  height: number
}

async function captureScreen(
  filePath: string,
  mode: ScreenshotCaptureMode = "fullscreen"
): Promise<void> {
  if (process.platform === "darwin") {
    const args =
      mode === "selection"
        ? ["-i", "-x", "-t", "png", filePath]
        : ["-x", "-t", "png", filePath]

    await execFileP("screencapture", args)
    if (mode === "selection" && !fs.existsSync(filePath)) {
      throw new ScreenshotCanceledError()
    }
    return
  }

  if (mode === "selection") {
    let bounds: CaptureBounds
    try {
      bounds = await getSelectionBounds()
    } catch (error) {
      if (error instanceof Error && error.message === "Selection canceled") {
        throw new ScreenshotCanceledError()
      }
      throw error
    }
    await captureBounds(filePath, bounds)
    return
  }

  await captureFullscreen(filePath)
}

async function captureFullscreen(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/'/g, "''")
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen
      $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $bitmap.Size)
      $bitmap.Save('${escapedPath}')
      $graphics.Dispose()
      $bitmap.Dispose()
    `
    await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])
  } else {
    const screenshot = (await import("screenshot-desktop")).default
    await screenshot({ filename: filePath, format: "png" })
  }
}

async function captureBounds(
  filePath: string,
  bounds: CaptureBounds
): Promise<void> {
  const normalizedBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }

  if (normalizedBounds.width < 1 || normalizedBounds.height < 1) {
    throw new Error("Selection is too small")
  }

  if (process.platform === "win32") {
    const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/'/g, "''")
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bitmap = New-Object System.Drawing.Bitmap ${normalizedBounds.width}, ${normalizedBounds.height}
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen(${normalizedBounds.x}, ${normalizedBounds.y}, 0, 0, $bitmap.Size)
      $bitmap.Save('${escapedPath}')
      $graphics.Dispose()
      $bitmap.Dispose()
    `
    await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])
    return
  }

  const temporaryPath = path.join(app.getPath("temp"), `${uuidv4()}.png`)
  await captureFullscreen(temporaryPath)
  await sharp(temporaryPath)
    .extract({
      left: normalizedBounds.x,
      top: normalizedBounds.y,
      width: normalizedBounds.width,
      height: normalizedBounds.height
    })
    .png()
    .toFile(filePath)
  await fs.promises.unlink(temporaryPath).catch((): void => undefined)
}

async function getSelectionBounds(): Promise<CaptureBounds> {
  const display = screen.getPrimaryDisplay()
  const selectionWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  selectionWindow.setAlwaysOnTop(true, "screen-saver", 1)
  selectionWindow.setIgnoreMouseEvents(false)

  const html = encodeURIComponent(`
    <!doctype html>
    <html>
      <head>
        <style>
          html, body {
            width: 100%;
            height: 100%;
            margin: 0;
            overflow: hidden;
            cursor: crosshair;
            user-select: none;
            background: rgba(0, 0, 0, 0.18);
          }
          #box {
            position: fixed;
            display: none;
            border: 2px solid #7dd3fc;
            background: rgba(125, 211, 252, 0.14);
            box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.22);
          }
        </style>
      </head>
      <body>
        <div id="box"></div>
        <script>
          const box = document.getElementById("box")
          let start = null

          window.addEventListener("keydown", event => {
            if (event.key === "Escape") {
              window.__selectionDone(null)
            }
          })

          window.addEventListener("mousedown", event => {
            start = { x: event.screenX, y: event.screenY, clientX: event.clientX, clientY: event.clientY }
            box.style.display = "block"
          })

          window.addEventListener("mousemove", event => {
            if (!start) return
            const left = Math.min(start.clientX, event.clientX)
            const top = Math.min(start.clientY, event.clientY)
            const width = Math.abs(event.clientX - start.clientX)
            const height = Math.abs(event.clientY - start.clientY)
            box.style.left = left + "px"
            box.style.top = top + "px"
            box.style.width = width + "px"
            box.style.height = height + "px"
          })

          window.addEventListener("mouseup", event => {
            if (!start) return
            const x = Math.min(start.x, event.screenX)
            const y = Math.min(start.y, event.screenY)
            const width = Math.abs(event.screenX - start.x)
            const height = Math.abs(event.screenY - start.y)
            window.__selectionDone({ x, y, width, height })
          })
        </script>
      </body>
    </html>
  `)

  try {
    await selectionWindow.loadURL(`data:text/html;charset=utf-8,${html}`)
    const bounds = await selectionWindow.webContents.executeJavaScript(`
      new Promise(resolve => {
        window.__selectionDone = resolve
      })
    `)

    if (!bounds) {
      throw new Error("Selection canceled")
    }

    return bounds
  } finally {
    if (!selectionWindow.isDestroyed()) {
      selectionWindow.close()
    }
    await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 200 : 100))
  }
}

export class ScreenshotHelper {
  private screenshotQueue: string[] = []
  private extraScreenshotQueue: string[] = []
  private readonly MAX_SCREENSHOTS = 5

  private readonly screenshotDir: string
  private readonly extraScreenshotDir: string

  private view: "queue" | "solutions" = "queue"

  constructor(view: "queue" | "solutions" = "queue") {
    this.view = view

    // Initialize directories
    this.screenshotDir = path.join(app.getPath("userData"), "screenshots")
    this.extraScreenshotDir = path.join(
      app.getPath("userData"),
      "extra_screenshots"
    )

    fs.mkdirSync(this.screenshotDir, { recursive: true })
    fs.mkdirSync(this.extraScreenshotDir, { recursive: true })
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotQueue
  }

  public getExtraScreenshotQueue(): string[] {
    return this.extraScreenshotQueue
  }

  public clearQueues(): void {
    // Clear screenshotQueue
    this.screenshotQueue.forEach((screenshotPath) => {
      fs.unlink(screenshotPath, (err) => {
        if (err)
          console.error(`Error deleting screenshot at ${screenshotPath}:`, err)
      })
    })
    this.screenshotQueue = []

    // Clear extraScreenshotQueue
    this.extraScreenshotQueue.forEach((screenshotPath) => {
      fs.unlink(screenshotPath, (err) => {
        if (err)
          console.error(
            `Error deleting extra screenshot at ${screenshotPath}:`,
            err
          )
      })
    })
    this.extraScreenshotQueue = []
  }

  public async takeScreenshot(
    hideMainWindow: () => void,
    showMainWindow: () => void,
    mode: ScreenshotCaptureMode = "fullscreen"
  ): Promise<string> {
    try {
      hideMainWindow()
      
      // Add a small delay to ensure window is hidden
      await new Promise(resolve => setTimeout(resolve, process.platform === "win32" ? 250 : 100))
      
      let screenshotPath = ""

      if (this.view === "queue") {
        screenshotPath = path.join(this.screenshotDir, `${uuidv4()}.png`)
        await captureScreen(screenshotPath, mode)

        this.screenshotQueue.push(screenshotPath)
        if (this.screenshotQueue.length > this.MAX_SCREENSHOTS) {
          const removedPath = this.screenshotQueue.shift()
          if (removedPath) {
            try {
              await fs.promises.unlink(removedPath)
            } catch (error) {
              console.error("Error removing old screenshot:", error)
            }
          }
        }
      } else {
        screenshotPath = path.join(this.extraScreenshotDir, `${uuidv4()}.png`)
        await captureScreen(screenshotPath, mode)

        this.extraScreenshotQueue.push(screenshotPath)
        if (this.extraScreenshotQueue.length > this.MAX_SCREENSHOTS) {
          const removedPath = this.extraScreenshotQueue.shift()
          if (removedPath) {
            try {
              await fs.promises.unlink(removedPath)
            } catch (error) {
              console.error("Error removing old screenshot:", error)
            }
          }
        }
      }

      return screenshotPath
    } catch (error) {
      console.error("Error taking screenshot:", error)
      throw new Error(`Failed to take screenshot: ${error.message}`)
    } finally {
      // Ensure window is always shown again
      showMainWindow()
    }
  }

  public async getImagePreview(filepath: string): Promise<string> {
    try {
      const data = await fs.promises.readFile(filepath)
      return `data:image/png;base64,${data.toString("base64")}`
    } catch (error) {
      console.error("Error reading image:", error)
      throw error
    }
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.promises.unlink(path)
      if (this.view === "queue") {
        this.screenshotQueue = this.screenshotQueue.filter(
          (filePath) => filePath !== path
        )
      } else {
        this.extraScreenshotQueue = this.extraScreenshotQueue.filter(
          (filePath) => filePath !== path
        )
      }
      return { success: true }
    } catch (error) {
      console.error("Error deleting file:", error)
      return { success: false, error: error.message }
    }
  }
}
