// ipcHandlers.ts

import { BrowserWindow, ipcMain, app, dialog, shell } from "electron"
import crypto from "crypto"
import { AppState } from "./main"
import { getAppSettings, getLaunchWorkingDirectory, updateAppSettings } from "./AppSettings"
import { getPersonalizationConfig, updatePersonalizationConfig } from "./PersonalizationStore"
import {
  getActiveChatSession,
  getChatSession,
  listChatSessions,
  resetActiveSession
} from "./HistoryStore"

export function initializeIpcHandlers(appState: AppState): void {
  const broadcastHistoryChanged = () => {
    const history = listChatSessions()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("history-changed", history)
    }
  }

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

  ipcMain.handle("clear-screenshots", async () => {
    appState.getScreenshotHelper().clearQueues()
    appState.setView("queue")
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("screenshots-cleared")
    }
    return { success: true }
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
    if (!appState.isVisible()) {
      await appState.processingHelper.prepareForLaunch()
    }
    appState.toggleMainWindow()
  })

  ipcMain.handle("show-main-window", async () => {
    await appState.processingHelper.prepareForLaunch()
    appState.showMainWindow()
  })

  ipcMain.handle("start-toolbar-session", async () => {
    appState.getScreenshotHelper().clearQueues()
    appState.setView("queue")
    appState.processingHelper.resetSession()
    await appState.processingHelper.prepareForLaunch()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("screenshots-cleared")
      window.webContents.send("history-changed", listChatSessions())
      window.webContents.send("reset-view")
    }
    appState.showMainWindow()
    return appState.processingHelper.getReadyStatus()
  })

  ipcMain.handle("prepare-codex", async () => {
    await appState.processingHelper.prepareForLaunch()
    return appState.processingHelper.getReadyStatus()
  })

  ipcMain.handle("get-codex-ready-status", async () => {
    return appState.processingHelper.getReadyStatus()
  })

  ipcMain.handle("hide-main-window", async () => {
    appState.hideMainWindow()
  })

  ipcMain.handle("toggle-current-window-maximize", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed() || !window.isMaximizable()) {
      return
    }

    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      appState.clearQueues()
      appState.processingHelper.resetSession()
      console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("chat", async (event, message: string) => {
    try {
      const response = await appState.processingHelper.getLLMHelper().streamAnswer(
        { message, workingDirectory: getLaunchWorkingDirectory(getAppSettings()) },
        { onHistoryChanged: broadcastHistoryChanged }
      )
      broadcastHistoryChanged()
      return response
    } catch (error: any) {
      console.error("Error in chat handler:", error);
      throw error;
    }
  });

  ipcMain.handle("clear-chat-history", async () => {
    resetActiveSession()
    appState.processingHelper.getLLMHelper().clearChatHistory()
    appState.processingHelper.invalidateReadyStatus()
    appState.processingHelper.prepareForLaunch().catch(error => {
      console.warn("Codex prelaunch failed after clearing chat:", error)
    })
    broadcastHistoryChanged()
    return { success: true }
  })

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
    await appState.processingHelper.prepareForLaunch()
    appState.centerAndShowWindow()
  })

  ipcMain.handle("show-answer-preview", async () => {
    const settings = getAppSettings()
    const main = appState.getMainWindow()
    if (main && !main.isDestroyed()) {
      const bounds = main.getBounds()
      // Reserve room for header/commands above the answer panel.
      appState.setWindowDimensions(bounds.width, settings.answerHeight + 120)
    }
    appState.centerAndShowWindow()
    if (main && !main.isDestroyed()) {
      main.webContents.send("show-answer-preview")
    }
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

  ipcMain.handle("get-app-settings", async () => {
    return getAppSettings()
  })

  ipcMain.handle("update-app-settings", async (_event, patch) => {
    const settings = updateAppSettings(patch)
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("app-settings-changed", settings)
    }
    if (
      "launchMode" in patch ||
      "selectedDirectoryId" in patch ||
      "directoryProfiles" in patch ||
      "workingDirectory" in patch ||
      "model" in patch ||
      "reasoningEffort" in patch
    ) {
      appState.processingHelper.invalidateReadyStatus()
      appState.processingHelper.prepareForLaunch().catch(error => {
        console.warn("Codex prelaunch failed after settings update:", error)
      })
    }
    return settings
  })

  ipcMain.handle("get-personalization", async () => {
    return getPersonalizationConfig()
  })

  ipcMain.handle("update-personalization", async (_event, patch) => {
    const settings = updatePersonalizationConfig(patch)
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("personalization-changed", settings)
    }
    return settings
  })

  ipcMain.handle("get-chat-history-index", async () => {
    return listChatSessions()
  })

  ipcMain.handle("get-chat-session", async (_event, id: string) => {
    return getChatSession(id)
  })

  ipcMain.handle("get-active-chat-session", async () => {
    return getActiveChatSession()
  })

  ipcMain.handle("new-chat-session", async () => {
    const session = resetActiveSession()
    appState.processingHelper.getLLMHelper().clearChatHistory()
    appState.processingHelper.invalidateReadyStatus()
    appState.processingHelper.prepareForLaunch().catch(error => {
      console.warn("Codex prelaunch failed after creating session:", error)
    })
    broadcastHistoryChanged()
    return session
  })

  ipcMain.handle("pick-working-directory", async (_event, options?: { initialPath?: string }) => {
    const settings = getAppSettings()
    const selectedProfile = settings.directoryProfiles.find(profile => profile.id === settings.selectedDirectoryId)
    const defaultPath = options?.initialPath?.trim() || selectedProfile?.path || app.getPath("home")
    const result = await (dialog as any).showOpenDialog({
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const selected = result.filePaths[0]
    const timestamp = new Date().toISOString()
    const existing = settings.directoryProfiles.find(profile => profile.path === selected)
    const profile = existing ?? {
      id: `dir_${crypto.randomUUID()}`,
      title: selected.split(/[\\/]/).filter(Boolean).at(-1) || "Working directory",
      path: selected,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const nextSettings = updateAppSettings({
      launchMode: "directory",
      selectedDirectoryId: profile.id,
      directoryProfiles: existing
        ? settings.directoryProfiles
        : [profile, ...settings.directoryProfiles],
      workingDirectory: selected,
    })
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("app-settings-changed", nextSettings)
    }
    appState.processingHelper.invalidateReadyStatus()
    appState.processingHelper.prepareForLaunch().catch(error => {
      console.warn("Codex prelaunch failed after picking directory:", error)
    })
    return selected
  })

  ipcMain.handle("open-directory", async (_event, directoryPath: string) => {
    const error = await shell.openPath(directoryPath)
    return error ? { success: false, error } : { success: true }
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
      appState.processingHelper.invalidateReadyStatus()
      appState.processingHelper.prepareForLaunch().catch(error => {
        console.warn("Codex prelaunch failed after model update:", error)
      })
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
