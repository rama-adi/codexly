// ProcessingHelper.ts

import { AppState } from "./main"
import { LLMHelper } from "./LLMHelper"
import dotenv from "dotenv"
import { getAppSettings, getLaunchWorkingDirectory } from "./AppSettings"
import { listChatSessions, resetActiveSession } from "./HistoryStore"
import { BrowserWindow } from "electron"

dotenv.config()

export type CodexReadyStatus = {
  state: "idle" | "warming" | "ready" | "error"
  key: string
  model: string
  cwd?: string
  threadId?: string | null
  error?: string
}

function broadcastHistoryChanged() {
  const history = listChatSessions()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("history-changed", history)
  }
}

export class ProcessingHelper {
  private appState: AppState
  private llmHelper: LLMHelper
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null
  private readyStatus: CodexReadyStatus = {
    state: "idle",
    key: "__direct__",
    model: getAppSettings().model,
    threadId: null,
  }
  private preparePromise: Promise<void> | null = null

  constructor(appState: AppState) {
    this.appState = appState
    this.llmHelper = new LLMHelper()
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.appState.getMainWindow()
    if (!mainWindow) return

    const view = this.appState.getView()

    if (view === "queue") {
      const screenshotQueue = this.appState.getScreenshotHelper().getScreenshotQueue()
      if (screenshotQueue.length === 0) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }

      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_START)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_START)
      this.appState.setView("solutions")
      this.currentProcessingAbortController = new AbortController()
      try {
        const settings = getAppSettings()
        await this.llmHelper.streamAnswer(
          {
            imagePaths: screenshotQueue,
            workingDirectory: getLaunchWorkingDirectory(settings),
            signal: this.currentProcessingAbortController.signal,
          },
          {
            onDelta: delta =>
              mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_DELTA, delta),
            onComplete: answer => {
              mainWindow.webContents.send(
                this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_COMPLETE,
                { answer }
              )
              broadcastHistoryChanged()
            },
            onHistoryChanged: broadcastHistoryChanged,
          }
        )
      } catch (error: any) {
        console.error("Image processing error:", error)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_ERROR, error.message)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
      } finally {
        this.currentProcessingAbortController = null
      }
      return
    }

    // Continuation mode: append extra screenshots to the active session.
    const extraScreenshotQueue = this.appState.getScreenshotHelper().getExtraScreenshotQueue()
    if (extraScreenshotQueue.length === 0) {
      console.log("No extra screenshots to process")
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
      return
    }

    mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_START)
    this.currentExtraProcessingAbortController = new AbortController()

    try {
      const settings = getAppSettings()
      await this.llmHelper.streamAnswer(
        {
          message: "Use these new screenshots to continue the current session and update the answer.",
          imagePaths: extraScreenshotQueue,
          workingDirectory: getLaunchWorkingDirectory(settings),
          signal: this.currentExtraProcessingAbortController.signal,
        },
        {
          onDelta: delta =>
            mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_DELTA, delta),
          onComplete: answer => {
            mainWindow.webContents.send(
              this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_COMPLETE,
              { answer }
            )
            broadcastHistoryChanged()
          },
          onHistoryChanged: broadcastHistoryChanged,
        }
      )

      this.appState.setHasContinuedSession(true)
    } catch (error: any) {
      console.error("Continuation processing error:", error)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_ERROR, error.message)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
    } finally {
      this.currentExtraProcessingAbortController = null
    }
  }

  public cancelOngoingRequests(): void {
    this.currentProcessingAbortController?.abort()
    this.currentProcessingAbortController = null
    this.currentExtraProcessingAbortController?.abort()
    this.currentExtraProcessingAbortController = null
    this.appState.setHasContinuedSession(false)
  }

  public resetSession(): void {
    resetActiveSession()
    this.llmHelper.clearChatHistory()
    this.invalidateReadyStatus()
  }

  public async prepareForLaunch(): Promise<void> {
    const settings = getAppSettings()
    const cwd = getLaunchWorkingDirectory(settings)
    const key = cwd || "__direct__"
    if (this.readyStatus.state === "ready" && this.readyStatus.key === key) return
    if (this.readyStatus.state === "warming" && this.readyStatus.key === key && this.preparePromise) {
      return this.preparePromise
    }

    this.setReadyStatus({ state: "warming", key, model: settings.model, cwd, threadId: null })
    this.preparePromise = this.llmHelper.prepareForLaunch(cwd)
      .then(async () => {
        const ready = await this.llmHelper.getReadyState(cwd)
        this.setReadyStatus({
          state: ready.ready ? "ready" : "idle",
          key,
          model: ready.model,
          cwd,
          threadId: ready.threadId,
        })
      })
      .catch(error => {
        this.setReadyStatus({
          state: "error",
          key,
          model: settings.model,
          cwd,
          threadId: null,
          error: error?.message ?? String(error),
        })
        throw error
      })
      .finally(() => {
        this.preparePromise = null
      })

    return this.preparePromise
  }

  public getReadyStatus(): CodexReadyStatus {
    return this.readyStatus
  }

  public invalidateReadyStatus(): void {
    const settings = getAppSettings()
    const cwd = getLaunchWorkingDirectory(settings)
    this.setReadyStatus({
      state: "idle",
      key: cwd || "__direct__",
      model: settings.model,
      cwd,
      threadId: null,
    })
  }

  public getLLMHelper() {
    return this.llmHelper
  }

  private setReadyStatus(status: CodexReadyStatus): void {
    this.readyStatus = status
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("codex-ready-status-changed", status)
    }
  }
}
