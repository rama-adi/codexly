// ipcHandlers.ts

import { BrowserWindow, ipcMain, app } from "electron"
import { AppState } from "./main"

export function initializeIpcHandlers(appState: AppState): void {
  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (width && height) {
        appState.setWindowDimensions(width, height)
      }
    }
  )

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return appState.deleteScreenshot(path)
  })

  ipcMain.handle("take-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      throw error
    }
  })

  ipcMain.handle("get-screenshots", async () => {
    console.log({ view: appState.getView() })
    try {
      let previews = []
      if (appState.getView() === "queue") {
        previews = await Promise.all(
          appState.getScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      } else {
        previews = await Promise.all(
          appState.getExtraScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      }
      previews.forEach((preview: any) => console.log(preview.path))
      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  ipcMain.handle("toggle-window", async () => {
    appState.toggleMainWindow()
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      appState.clearQueues()
      console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })

  // IPC handler for analyzing image from file path
  ipcMain.handle("analyze-image-file", async (event, path: string) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().analyzeImageFile(path)
      return result
    } catch (error: any) {
      console.error("Error in analyze-image-file handler:", error)
      throw error
    }
  })

  ipcMain.handle("chat", async (event, message: string) => {
    try {
      return await appState.processingHelper.getLLMHelper().chat(message);
    } catch (error: any) {
      console.error("Error in chat handler:", error);
      throw error;
    }
  });

  ipcMain.handle("quit-app", () => {
    appState.quitApp()
  })

  ipcMain.handle("set-ignore-mouse-events", (event, ignore: boolean) => {
    const win = appState.getMainWindow()
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // Window movement handlers
  ipcMain.handle("move-window-left", async () => {
    appState.moveWindowLeft()
  })

  ipcMain.handle("move-window-right", async () => {
    appState.moveWindowRight()
  })

  ipcMain.handle("move-window-up", async () => {
    appState.moveWindowUp()
  })

  ipcMain.handle("move-window-down", async () => {
    appState.moveWindowDown()
  })

  ipcMain.handle("center-and-show-window", async () => {
    appState.centerAndShowWindow()
  })

  ipcMain.handle("open-settings-window", async () => {
    appState.openSettingsWindow()
  })

  ipcMain.handle("close-settings-window", async () => {
    appState.closeSettingsWindow()
  })

  ipcMain.handle("minimize-settings-window", async () => {
    appState.minimizeSettingsWindow()
  })

  ipcMain.handle("get-stealth-enabled", async () => {
    return { stealthEnabled: appState.getStealthEnabled() }
  })

  ipcMain.handle("set-stealth-enabled", async (_event, enabled: boolean) => {
    const result = appState.setStealthEnabled(Boolean(enabled))
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("stealth-changed", result)
    }
    return result
  })

  // LLM Model Management Handlers
  ipcMain.handle("get-current-llm-config", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return {
        provider: llmHelper.getCurrentProvider(),
        model: llmHelper.getCurrentModel(),
      };
    } catch (error: any) {
      console.error("Error getting current LLM config:", error);
      throw error;
    }
  });

  ipcMain.handle("get-available-llm-models", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return await llmHelper.getAvailableModels();
    } catch (error: any) {
      console.error("Error getting available LLM models:", error);
      throw error;
    }
  });

  ipcMain.handle("set-current-llm-model", async (_event, model: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const config = llmHelper.setCurrentModel(model);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("llm-config-changed", config);
      }
      return config;
    } catch (error: any) {
      console.error("Error setting current LLM model:", error);
      throw error;
    }
  });

  ipcMain.handle("test-llm-connection", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const result = await llmHelper.testConnection();
      return result;
    } catch (error: any) {
      console.error("Error testing LLM connection:", error);
      return { success: false, error: error.message };
    }
  });
}
