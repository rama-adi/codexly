// ProcessingHelper.ts

import { AppState } from "../main"
import { LLMHelper } from "./LLMHelper"
import dotenv from "dotenv"
import { getAppSettings, getLaunchWorkingDirectory } from "../stores/AppSettings"
import { resetActiveSession } from "../stores/HistoryStore"
import { BrowserWindow } from "electron"
import { devLog, devMeasure } from "../utils/devLog"

dotenv.config()

export type CodexReadyStatus = {
  state: "idle" | "warming" | "ready" | "error"
  key: string
  model: string
  cwd?: string
  threadId?: string | null
  error?: string
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

  private broadcastHistoryChanged(): void {
    const done = devMeasure("history", "broadcastHistoryChanged")
    const send = (history: Array<{ id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }>) => {
      devLog("history", "broadcast history payload", { count: history.length, windowCount: BrowserWindow.getAllWindows().length })
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("history-changed", history)
      }
    }
    send(this.llmHelper.getCachedChatSessions())
    this.llmHelper.listChatSessions()
      .then(history => {
        send(history)
        done({ count: history.length })
      })
      .catch(error => {
        if (!this.llmHelper.shouldIgnoreBackgroundError(error)) console.warn("Failed to broadcast Codex history:", error)
        done({ error: error?.message ?? String(error) })
      })
  }

  public async processScreenshots(): Promise<void> {
    const done = devMeasure("processing", "processScreenshots")
    const mainWindow = this.appState.getMainWindow()
    if (!mainWindow) {
      done({ skipped: "no-main-window" })
      return
    }

    const view = this.appState.getView()
    devLog("processing", "processScreenshots view", {
      view,
      queueCount: this.appState.getScreenshotHelper().getScreenshotQueue().length,
      extraQueueCount: this.appState.getScreenshotHelper().getExtraScreenshotQueue().length,
    })

    if (view === "queue") {
      const screenshotQueue = this.appState.getScreenshotHelper().getScreenshotQueue()
      if (screenshotQueue.length === 0) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        done({ skipped: "no-screenshots" })
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
            onStreamEvent: delta =>
              mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_DELTA, delta),
            onComplete: answer => {
              mainWindow.webContents.send(
                this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_COMPLETE,
                { answer }
              )
              this.broadcastHistoryChanged()
            },
            onHistoryChanged: () => this.broadcastHistoryChanged(),
          }
        )
      } catch (error: any) {
        console.error("Image processing error:", error)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_ERROR, error.message)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
      } finally {
        this.currentProcessingAbortController = null
        done({ mode: "initial" })
      }
      return
    }

    // Continuation mode: append extra screenshots to the active session.
    const extraScreenshotQueue = this.appState.getScreenshotHelper().getExtraScreenshotQueue()
    if (extraScreenshotQueue.length === 0) {
      console.log("No extra screenshots to process")
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
      done({ skipped: "no-extra-screenshots" })
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
          onStreamEvent: delta =>
            mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_DELTA, delta),
          onComplete: answer => {
            mainWindow.webContents.send(
              this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_COMPLETE,
              { answer }
            )
            this.broadcastHistoryChanged()
          },
          onHistoryChanged: () => this.broadcastHistoryChanged(),
        }
      )

      this.appState.setHasContinuedSession(true)
    } catch (error: any) {
      console.error("Continuation processing error:", error)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_STREAM_ERROR, error.message)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
    } finally {
      this.currentExtraProcessingAbortController = null
      done({ mode: "continuation" })
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
    this.llmHelper.resetActiveThread()
  }

  public async prepareForLaunch(workingDirectory?: string): Promise<void> {
    const done = devMeasure("processing", "prepareForLaunch")
    const settings = getAppSettings()
    const cwd = workingDirectory ?? getLaunchWorkingDirectory(settings)
    const key = cwd || "__direct__"
    if (this.readyStatus.state === "ready" && this.readyStatus.key === key) {
      done({ cached: true, state: this.readyStatus.state, key })
      return
    }
    if (this.readyStatus.state === "warming" && this.readyStatus.key === key && this.preparePromise) {
      devLog("processing", "prepareForLaunch joined in-flight warmup", { key })
      this.preparePromise.finally((): void => done({ joined: true, key })).catch((): undefined => undefined)
      return this.preparePromise
    }

    devLog("processing", "prepareForLaunch warming", { key, model: settings.model, cwd })
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
        done({ key, state: this.readyStatus.state, threadId: this.readyStatus.threadId ?? null })
      })
    this.llmHelper.refreshChatSessionsInBackground()

    return this.preparePromise
  }

  public async prepareForActiveSession(): Promise<void> {
    devLog("processing", "prepareForActiveSession", {
      cwd: this.llmHelper.getActiveChatSessionWorkingDirectory() ?? null,
    })
    await this.prepareForLaunch(this.llmHelper.getActiveChatSessionWorkingDirectory())
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
    devLog("processing", "ready status changed", status as unknown as Record<string, unknown>)
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("codex-ready-status-changed", status)
    }
  }
}
