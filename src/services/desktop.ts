import type {
  AppSettings,
  CodexReadyStatus,
  HistoryIndexItem,
  PersonalizationConfig,
  ScreenshotPreview,
} from "@/shared/ipc"

const bridge = () => window.appBridge

export const layoutService = {
  updateContentDimensions: (dimensions: { width: number; height: number }) =>
    bridge().layout.updateContentDimensions(dimensions),
  setIgnoreMouseEvents: (ignore: boolean) => bridge().layout.setIgnoreMouseEvents(ignore),
}

export const screenshotService = {
  take: () => bridge().screenshots.take(),
  list: () => bridge().screenshots.list(),
  delete: (path: string) => bridge().screenshots.delete(path),
  clear: () => bridge().screenshots.clear(),
  resetQueues: () => bridge().screenshots.resetQueues(),
  onTaken: (callback: (data: ScreenshotPreview) => void) => bridge().screenshots.onTaken(callback),
  onCleared: (callback: () => void) => bridge().screenshots.onCleared(callback),
  onBufferCleared: (callback: () => void) => bridge().screenshots.onBufferCleared(callback),
}

export const processingService = {
  chat: (message: string) => bridge().processing.chat(message),
  clearChatHistory: () => bridge().processing.clearChatHistory(),
  clearChatSessions: () => bridge().processing.clearChatSessions(),
  startToolbarSession: () => bridge().processing.startToolbarSession(),
  prepareCodex: () => bridge().processing.prepareCodex(),
  getCodexReadyStatus: () => bridge().processing.getCodexReadyStatus(),
  showAnswerPreview: () => bridge().processing.showAnswerPreview(),
  onResetView: (callback: () => void) => bridge().processing.onResetView(callback),
  onSolutionStreamStart: (callback: () => void) =>
    bridge().processing.onSolutionStreamStart(callback),
  onSolutionStreamDelta: (callback: (delta: string) => void) =>
    bridge().processing.onSolutionStreamDelta(callback),
  onSolutionStreamComplete: (callback: (data: { answer: string }) => void) =>
    bridge().processing.onSolutionStreamComplete(callback),
  onSolutionStreamError: (callback: (error: string) => void) =>
    bridge().processing.onSolutionStreamError(callback),
  onNoScreenshots: (callback: () => void) => bridge().processing.onNoScreenshots(callback),
  onUnauthorized: (callback: () => void) => bridge().processing.onUnauthorized(callback),
  onReadyStatusChanged: (callback: (status: CodexReadyStatus) => void) =>
    bridge().processing.onReadyStatusChanged(callback),
  onShowAnswerPreview: (callback: () => void) => bridge().processing.onShowAnswerPreview(callback),
}

export const shellService = {
  get platform() {
    return bridge().platform
  },
  quitApp: () => bridge().shell.quitApp(),
  closeCurrentWindow: () => bridge().shell.closeCurrentWindow(),
  minimizeCurrentWindow: () => bridge().shell.minimizeCurrentWindow(),
  openSettingsWindow: () => bridge().shell.openSettingsWindow(),
  closeSettingsWindow: () => bridge().shell.closeSettingsWindow(),
  minimizeSettingsWindow: () => bridge().shell.minimizeSettingsWindow(),
  showMainWindow: () => bridge().shell.showMainWindow(),
  hideMainWindow: () => bridge().shell.hideMainWindow(),
  toggleMainWindow: () => bridge().shell.toggleMainWindow(),
  toggleCurrentWindowMaximize: () => bridge().shell.toggleCurrentWindowMaximize(),
  moveWindowLeft: () => bridge().shell.moveWindowLeft(),
  moveWindowRight: () => bridge().shell.moveWindowRight(),
  moveWindowUp: () => bridge().shell.moveWindowUp(),
  moveWindowDown: () => bridge().shell.moveWindowDown(),
  pickWorkingDirectory: (options?: { initialPath?: string }) =>
    bridge().shell.pickWorkingDirectory(options),
  openDirectory: (path: string) => bridge().shell.openDirectory(path),
}

export const settingsService = {
  getStealthEnabled: () => bridge().settings.getStealthEnabled(),
  setStealthEnabled: (enabled: boolean) => bridge().settings.setStealthEnabled(enabled),
  getAppSettings: () => bridge().settings.getAppSettings(),
  updateAppSettings: (patch: Partial<AppSettings>) => bridge().settings.updateAppSettings(patch),
  onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) =>
    bridge().settings.onStealthChanged(callback),
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) =>
    bridge().settings.onAppSettingsChanged(callback),
}

export const personalizationService = {
  get: () => bridge().personalization.get(),
  update: (patch: Partial<PersonalizationConfig>) => bridge().personalization.update(patch),
  onChanged: (callback: (config: PersonalizationConfig) => void) =>
    bridge().personalization.onChanged(callback),
}

export const historyService = {
  getIndex: () => bridge().history.getIndex(),
  getSession: (sessionId: string) => bridge().history.getSession(sessionId),
  getActiveSession: () => bridge().history.getActiveSession(),
  activateSession: (sessionId: string) => bridge().history.activateSession(sessionId),
  deleteSession: (sessionId: string) => bridge().history.deleteSession(sessionId),
  newSession: () => bridge().history.newSession(),
  onChanged: (callback: (history: HistoryIndexItem[]) => void) =>
    bridge().history.onChanged(callback),
}

export const llmService = {
  getCurrentConfig: () => bridge().llm.getCurrentConfig(),
  getAvailableModels: () => bridge().llm.getAvailableModels(),
  setCurrentModel: (model: string) => bridge().llm.setCurrentModel(model),
  testConnection: () => bridge().llm.testConnection(),
  onConfigChanged: (callback: (config: { provider: string; model: string }) => void) =>
    bridge().llm.onConfigChanged(callback),
}
