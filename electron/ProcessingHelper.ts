// ProcessingHelper.ts

import { AppState } from "./main"
import { LLMHelper } from "./LLMHelper"
import dotenv from "dotenv"
import { getAppSettings } from "./AppSettings"

dotenv.config()

export class ProcessingHelper {
  private appState: AppState
  private llmHelper: LLMHelper
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

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
      this.appState.setView("solutions")
      this.currentProcessingAbortController = new AbortController()
      try {
        const settings = getAppSettings()
        const problemInfo =
          settings.mode === "coding"
            ? await this.llmHelper.extractProblemFromImages(screenshotQueue)
            : {
                problem_statement: (await this.llmHelper.analyzeImageFiles(screenshotQueue)).text,
                input_format: { description: "Generated from screenshot", parameters: [] as any[] },
                output_format: { description: "Generated from screenshot", type: "string", subtype: "text" },
                complexity: { time: "N/A", space: "N/A" },
                test_cases: [] as any[],
                validation_type: "manual",
                difficulty: "custom",
              }
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.PROBLEM_EXTRACTED, problemInfo)
        this.appState.setProblemInfo(problemInfo)
        const solution = await this.llmHelper.generateSolution(problemInfo)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_SUCCESS, solution)
      } catch (error: any) {
        console.error("Image processing error:", error)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, error.message)
      } finally {
        this.currentProcessingAbortController = null
      }
      return
    }

    // Debug mode
    const extraScreenshotQueue = this.appState.getScreenshotHelper().getExtraScreenshotQueue()
    if (extraScreenshotQueue.length === 0) {
      console.log("No extra screenshots to process")
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
      return
    }

    mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.DEBUG_START)
    this.currentExtraProcessingAbortController = new AbortController()

    try {
      const problemInfo = this.appState.getProblemInfo()
      if (!problemInfo) throw new Error("No problem info available")

      if (getAppSettings().mode !== "coding") {
        throw new Error("Debugging is only available in coding mode")
      }

      const currentSolution = await this.llmHelper.generateSolution(problemInfo)
      const currentCode = currentSolution.solution.code

      const debugResult = await this.llmHelper.debugSolutionWithImages(
        problemInfo,
        currentCode,
        extraScreenshotQueue,
      )

      this.appState.setHasDebugged(true)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.DEBUG_SUCCESS, debugResult)
    } catch (error: any) {
      console.error("Debug processing error:", error)
      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.DEBUG_ERROR, error.message)
    } finally {
      this.currentExtraProcessingAbortController = null
    }
  }

  public cancelOngoingRequests(): void {
    this.currentProcessingAbortController?.abort()
    this.currentProcessingAbortController = null
    this.currentExtraProcessingAbortController?.abort()
    this.currentExtraProcessingAbortController = null
    this.appState.setHasDebugged(false)
  }

  public getLLMHelper() {
    return this.llmHelper
  }
}
