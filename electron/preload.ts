import { contextBridge, ipcRenderer } from "electron"

type AppMode = "simpleQA" | "coding"
type ResponseType = "concise" | "thorough"
type AppSettings = {
  model: string
  stealthEnabled: boolean
  mode: AppMode
  responseType: ResponseType
  codingLanguage: string
  responseLanguage: string
  answerHeight: number
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  launchMode: "direct" | "directory"
  selectedDirectoryId: string | null
  directoryProfiles: DirectoryProfile[]
  workingDirectory: string
}

type DirectoryProfile = {
  id: string
  title: string
  path: string
  createdAt: string
  updatedAt: string
}

type PersonalizationConfig = {
  mode: "question" | "coding"
  verbosity: "concise" | "verbose"
  customInstructionsEnabled: boolean
  customInstructions: string
}

type HistoryIndexItem = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

type ChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workingDirectory?: string
  codexThreadId?: string
  messages: Array<{
    id: string
    role: "user" | "assistant"
    content: string
    screenshotPaths?: string[]
    screenshotDataUrls?: string[]
    screenshots?: Array<{ path: string; dataUrl: string }>
    createdAt: string
  }>
}

type CodexReadyStatus = {
  state: "idle" | "warming" | "ready" | "error"
  key: string
  model: string
  cwd?: string
  threadId?: string | null
  error?: string
}

interface ElectronAPI {
  platform: NodeJS.Platform
  updateContentDimensions: (dimensions: { width: number; height: number }) => Promise<void>
  takeScreenshot: () => Promise<{ path: string; preview: string }>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (path: string) => Promise<{ success: boolean; error?: string }>
  clearScreenshots: () => Promise<{ success: boolean }>
  clearChatHistory: () => Promise<{ success: boolean }>
  chat: (message: string) => Promise<string>
  quitApp: () => Promise<void>
  openSettingsWindow: () => Promise<void>
  closeSettingsWindow: () => Promise<void>
  minimizeSettingsWindow: () => Promise<void>
  showMainWindow: () => Promise<void>
  prepareCodex: () => Promise<CodexReadyStatus>
  getCodexReadyStatus: () => Promise<CodexReadyStatus>
  hideMainWindow: () => Promise<void>
  toggleMainWindow: () => Promise<void>
  toggleCurrentWindowMaximize: () => Promise<void>
  setIgnoreMouseEvents: (ignore: boolean) => Promise<void>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>
  getStealthEnabled: () => Promise<{ stealthEnabled: boolean }>
  setStealthEnabled: (enabled: boolean) => Promise<{ stealthEnabled: boolean }>
  getAppSettings: () => Promise<AppSettings>
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  pickWorkingDirectory: (options?: { initialPath?: string }) => Promise<string | null>
  openDirectory: (path: string) => Promise<{ success: boolean; error?: string }>
  getPersonalization: () => Promise<PersonalizationConfig>
  updatePersonalization: (patch: Partial<PersonalizationConfig>) => Promise<PersonalizationConfig>
  getChatHistoryIndex: () => Promise<HistoryIndexItem[]>
  getChatSession: (sessionId: string) => Promise<ChatSession | null>
  getActiveChatSession: () => Promise<ChatSession | null>
  newChatSession: () => Promise<ChatSession>
  showAnswerPreview: () => Promise<void>
  getCurrentLlmConfig: () => Promise<{ provider: string; model: string }>
  getAvailableLlmModels: () => Promise<Array<{ id: string; name: string }>>
  setCurrentLlmModel: (model: string) => Promise<{ provider: string; model: string }>
  testLlmConnection: () => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (callback: (data: { path: string; preview: string }) => void) => () => void
  onScreenshotsCleared: (callback: () => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStreamStart: (callback: () => void) => () => void
  onSolutionStreamDelta: (callback: (delta: string) => void) => () => void
  onSolutionStreamComplete: (callback: (data: { answer: string }) => void) => () => void
  onSolutionStreamError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) => () => void
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  onPersonalizationChanged: (callback: (config: PersonalizationConfig) => void) => () => void
  onHistoryChanged: (callback: (history: HistoryIndexItem[]) => void) => () => void
  onCodexReadyStatusChanged: (callback: (status: CodexReadyStatus) => void) => () => void
  onShowAnswerPreview: (callback: () => void) => () => void
  onLlmConfigChanged: (callback: (config: { provider: string; model: string }) => void) => () => void
  invoke: (channel: string, ...args: any[]) => Promise<any>
}

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

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  updateContentDimensions: dimensions => ipcRenderer.invoke("update-content-dimensions", dimensions),
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  getScreenshots: () => ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: path => ipcRenderer.invoke("delete-screenshot", path),
  clearScreenshots: () => ipcRenderer.invoke("clear-screenshots"),
  clearChatHistory: () => ipcRenderer.invoke("clear-chat-history"),
  chat: message => ipcRenderer.invoke("chat", message),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  openSettingsWindow: () => ipcRenderer.invoke("open-settings-window"),
  closeSettingsWindow: () => ipcRenderer.invoke("close-settings-window"),
  minimizeSettingsWindow: () => ipcRenderer.invoke("minimize-settings-window"),
  showMainWindow: () => ipcRenderer.invoke("show-main-window"),
  prepareCodex: () => ipcRenderer.invoke("prepare-codex"),
  getCodexReadyStatus: () => ipcRenderer.invoke("get-codex-ready-status"),
  hideMainWindow: () => ipcRenderer.invoke("hide-main-window"),
  toggleMainWindow: () => ipcRenderer.invoke("toggle-window"),
  toggleCurrentWindowMaximize: () => ipcRenderer.invoke("toggle-current-window-maximize"),
  setIgnoreMouseEvents: ignore => ipcRenderer.invoke("set-ignore-mouse-events", ignore),
  moveWindowLeft: () => ipcRenderer.invoke("move-window-left"),
  moveWindowRight: () => ipcRenderer.invoke("move-window-right"),
  moveWindowUp: () => ipcRenderer.invoke("move-window-up"),
  moveWindowDown: () => ipcRenderer.invoke("move-window-down"),
  getStealthEnabled: () => ipcRenderer.invoke("get-stealth-enabled"),
  setStealthEnabled: enabled => ipcRenderer.invoke("set-stealth-enabled", enabled),
  getAppSettings: () => ipcRenderer.invoke("get-app-settings"),
  updateAppSettings: patch => ipcRenderer.invoke("update-app-settings", patch),
  pickWorkingDirectory: options => ipcRenderer.invoke("pick-working-directory", options),
  openDirectory: path => ipcRenderer.invoke("open-directory", path),
  getPersonalization: () => ipcRenderer.invoke("get-personalization"),
  updatePersonalization: patch => ipcRenderer.invoke("update-personalization", patch),
  getChatHistoryIndex: () => ipcRenderer.invoke("get-chat-history-index"),
  getChatSession: sessionId => ipcRenderer.invoke("get-chat-session", sessionId),
  getActiveChatSession: () => ipcRenderer.invoke("get-active-chat-session"),
  newChatSession: () => ipcRenderer.invoke("new-chat-session"),
  showAnswerPreview: () => ipcRenderer.invoke("show-answer-preview"),
  getCurrentLlmConfig: () => ipcRenderer.invoke("get-current-llm-config"),
  getAvailableLlmModels: () => ipcRenderer.invoke("get-available-llm-models"),
  setCurrentLlmModel: model => ipcRenderer.invoke("set-current-llm-model", model),
  testLlmConnection: () => ipcRenderer.invoke("test-llm-connection"),
  onScreenshotTaken: callback => on("screenshot-taken", callback),
  onScreenshotsCleared: callback => {
    const subscription = () => callback()
    ipcRenderer.on("screenshots-cleared", subscription)
    return () => ipcRenderer.removeListener("screenshots-cleared", subscription)
  },
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
  onProcessingNoScreenshots: callback => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    return () => ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
  },
  onUnauthorized: callback => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    return () => ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
  },
  onStealthChanged: callback => on("stealth-changed", callback),
  onAppSettingsChanged: callback => on("app-settings-changed", callback),
  onPersonalizationChanged: callback => on("personalization-changed", callback),
  onHistoryChanged: callback => on("history-changed", callback),
  onCodexReadyStatusChanged: callback => on("codex-ready-status-changed", callback),
  onShowAnswerPreview: callback => {
    const subscription = () => callback()
    ipcRenderer.on("show-answer-preview", subscription)
    return () => ipcRenderer.removeListener("show-answer-preview", subscription)
  },
  onLlmConfigChanged: callback => on("llm-config-changed", callback),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
} satisfies ElectronAPI)
