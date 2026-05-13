import { contextBridge, ipcRenderer } from "electron"
import type { AppBridge } from "../src/shared/ipc"

export const PROCESSING_EVENTS = {
  UNAUTHORIZED: "procesing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",
  INITIAL_START: "initial-start",
  INITIAL_SOLUTION_ERROR: "solution-error",
  SOLUTION_STREAM_START: "solution-stream-start",
  SOLUTION_STREAM_DELTA: "solution-stream-delta",
  SOLUTION_STREAM_COMPLETE: "solution-stream-complete",
  SOLUTION_STREAM_ERROR: "solution-stream-error",
} as const

function on<T>(channel: string, callback: (payload: T) => void): () => void {
  const subscription = (_: unknown, payload: T) => callback(payload)
  ipcRenderer.on(channel, subscription)
  return () => ipcRenderer.removeListener(channel, subscription)
}

const appBridge = {
  platform: process.platform,
  layout: {
    updateContentDimensions: dimensions => ipcRenderer.invoke("update-content-dimensions", dimensions),
    setIgnoreMouseEvents: ignore => ipcRenderer.invoke("set-ignore-mouse-events", ignore),
  },
  screenshots: {
    take: () => ipcRenderer.invoke("take-screenshot"),
    list: () => ipcRenderer.invoke("get-screenshots"),
    delete: path => ipcRenderer.invoke("delete-screenshot", path),
    clear: () => ipcRenderer.invoke("clear-screenshots"),
    resetQueues: () => ipcRenderer.invoke("reset-queues"),
    onTaken: callback => on("screenshot-taken", callback),
    onCleared: callback => {
      const subscription = () => callback()
      ipcRenderer.on("screenshots-cleared", subscription)
      return () => ipcRenderer.removeListener("screenshots-cleared", subscription)
    },
    onBufferCleared: callback => {
      const subscription = () => callback()
      ipcRenderer.on("buffer-cleared", subscription)
      return () => ipcRenderer.removeListener("buffer-cleared", subscription)
    },
  },
  processing: {
    chat: message => ipcRenderer.invoke("chat", message),
    clearChatHistory: () => ipcRenderer.invoke("clear-chat-history"),
    clearChatSessions: () => ipcRenderer.invoke("clear-chat-sessions"),
    startToolbarSession: () => ipcRenderer.invoke("start-toolbar-session"),
    prepareCodex: () => ipcRenderer.invoke("prepare-codex"),
    getCodexReadyStatus: () => ipcRenderer.invoke("get-codex-ready-status"),
    showAnswerPreview: () => ipcRenderer.invoke("show-answer-preview"),
    onResetView: callback => {
      const subscription = () => callback()
      ipcRenderer.on("reset-view", subscription)
      return () => ipcRenderer.removeListener("reset-view", subscription)
    },
    onSolutionStreamStart: callback => {
      const subscription = () => callback()
      ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_STREAM_START, subscription)
      return () => ipcRenderer.removeListener(PROCESSING_EVENTS.SOLUTION_STREAM_START, subscription)
    },
    onSolutionStreamDelta: callback => on(PROCESSING_EVENTS.SOLUTION_STREAM_DELTA, callback),
    onSolutionStreamComplete: callback => on(PROCESSING_EVENTS.SOLUTION_STREAM_COMPLETE, callback),
    onSolutionStreamError: callback => on(PROCESSING_EVENTS.SOLUTION_STREAM_ERROR, callback),
    onNoScreenshots: callback => {
      const subscription = () => callback()
      ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
      return () => ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    },
    onUnauthorized: callback => {
      const subscription = () => callback()
      ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
      return () => ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    },
    onReadyStatusChanged: callback => on("codex-ready-status-changed", callback),
    onShowAnswerPreview: callback => {
      const subscription = () => callback()
      ipcRenderer.on("show-answer-preview", subscription)
      return () => ipcRenderer.removeListener("show-answer-preview", subscription)
    },
  },
  shell: {
    quitApp: () => ipcRenderer.invoke("quit-app"),
    closeCurrentWindow: () => ipcRenderer.invoke("close-current-window"),
    minimizeCurrentWindow: () => ipcRenderer.invoke("minimize-current-window"),
    openSettingsWindow: () => ipcRenderer.invoke("open-settings-window"),
    closeSettingsWindow: () => ipcRenderer.invoke("close-settings-window"),
    minimizeSettingsWindow: () => ipcRenderer.invoke("minimize-settings-window"),
    showMainWindow: () => ipcRenderer.invoke("show-main-window"),
    hideMainWindow: () => ipcRenderer.invoke("hide-main-window"),
    toggleMainWindow: () => ipcRenderer.invoke("toggle-window"),
    toggleCurrentWindowMaximize: () => ipcRenderer.invoke("toggle-current-window-maximize"),
    moveWindowLeft: () => ipcRenderer.invoke("move-window-left"),
    moveWindowRight: () => ipcRenderer.invoke("move-window-right"),
    moveWindowUp: () => ipcRenderer.invoke("move-window-up"),
    moveWindowDown: () => ipcRenderer.invoke("move-window-down"),
    pickWorkingDirectory: options => ipcRenderer.invoke("pick-working-directory", options),
    openDirectory: path => ipcRenderer.invoke("open-directory", path),
  },
  settings: {
    getStealthEnabled: () => ipcRenderer.invoke("get-stealth-enabled"),
    setStealthEnabled: enabled => ipcRenderer.invoke("set-stealth-enabled", enabled),
    getAppSettings: () => ipcRenderer.invoke("get-app-settings"),
    updateAppSettings: patch => ipcRenderer.invoke("update-app-settings", patch),
    onStealthChanged: callback => on("stealth-changed", callback),
    onAppSettingsChanged: callback => on("app-settings-changed", callback),
  },
  personalization: {
    get: () => ipcRenderer.invoke("get-personalization"),
    update: patch => ipcRenderer.invoke("update-personalization", patch),
    onChanged: callback => on("personalization-changed", callback),
  },
  history: {
    getIndex: () => ipcRenderer.invoke("get-chat-history-index"),
    getSession: sessionId => ipcRenderer.invoke("get-chat-session", sessionId),
    getActiveSession: () => ipcRenderer.invoke("get-active-chat-session"),
    activateSession: sessionId => ipcRenderer.invoke("activate-chat-session", sessionId),
    deleteSession: sessionId => ipcRenderer.invoke("delete-chat-session", sessionId),
    newSession: () => ipcRenderer.invoke("new-chat-session"),
    onChanged: callback => on("history-changed", callback),
  },
  llm: {
    getCurrentConfig: () => ipcRenderer.invoke("get-current-llm-config"),
    getAvailableModels: () => ipcRenderer.invoke("get-available-llm-models"),
    setCurrentModel: model => ipcRenderer.invoke("set-current-llm-model", model),
    testConnection: () => ipcRenderer.invoke("test-llm-connection"),
    onConfigChanged: callback => on("llm-config-changed", callback),
  },
} satisfies AppBridge

contextBridge.exposeInMainWorld("appBridge", appBridge)
