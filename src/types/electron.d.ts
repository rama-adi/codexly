export type AppMode = "simpleQA" | "coding"
export type ResponseType = "concise" | "thorough"

export interface AppSettings {
  model: string
  stealthEnabled: boolean
  mode: AppMode
  responseType: ResponseType
  codingLanguage: string
  responseLanguage: string
  answerHeight: number
  launchMode: "direct" | "directory"
  selectedDirectoryId: string | null
  directoryProfiles: DirectoryProfile[]
  workingDirectory: string
}

export interface DirectoryProfile {
  id: string
  title: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface PersonalizationConfig {
  mode: "question" | "coding"
  verbosity: "concise" | "verbose"
  customInstructionsEnabled: boolean
  customInstructions: string
}

export interface HistoryIndexItem {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface ChatSession extends HistoryIndexItem {
  workingDirectory?: string
  messages: Array<{
    id: string
    role: "user" | "assistant"
    content: string
    screenshotPaths?: string[]
    createdAt: string
  }>
}

export interface ElectronAPI {
  platform: NodeJS.Platform
  updateContentDimensions: (dimensions: { width: number; height: number }) => Promise<void>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (path: string) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (callback: (data: { path: string; preview: string }) => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStreamStart: (callback: () => void) => () => void
  onSolutionStreamDelta: (callback: (delta: string) => void) => () => void
  onSolutionStreamComplete: (callback: (data: { answer: string }) => void) => () => void
  onSolutionStreamError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  takeScreenshot: () => Promise<{ path: string; preview: string }>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>
  clearChatHistory: () => Promise<{ success: boolean }>
  chat: (message: string) => Promise<string>
  quitApp: () => Promise<void>
  openSettingsWindow: () => Promise<void>
  closeSettingsWindow: () => Promise<void>
  minimizeSettingsWindow: () => Promise<void>
  showMainWindow: () => Promise<void>
  hideMainWindow: () => Promise<void>
  toggleMainWindow: () => Promise<void>
  toggleCurrentWindowMaximize: () => Promise<void>
  setIgnoreMouseEvents: (ignore: boolean) => Promise<void>
  getStealthEnabled: () => Promise<{ stealthEnabled: boolean }>
  setStealthEnabled: (enabled: boolean) => Promise<{ stealthEnabled: boolean }>
  onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) => () => void
  getAppSettings: () => Promise<AppSettings>
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  pickWorkingDirectory: (options?: { initialPath?: string }) => Promise<string | null>
  openDirectory: (path: string) => Promise<{ success: boolean; error?: string }>
  getPersonalization: () => Promise<PersonalizationConfig>
  updatePersonalization: (patch: Partial<PersonalizationConfig>) => Promise<PersonalizationConfig>
  onPersonalizationChanged: (callback: (config: PersonalizationConfig) => void) => () => void
  getChatHistoryIndex: () => Promise<HistoryIndexItem[]>
  getChatSession: (sessionId: string) => Promise<ChatSession | null>
  newChatSession: () => Promise<ChatSession>
  onHistoryChanged: (callback: (history: HistoryIndexItem[]) => void) => () => void
  showAnswerPreview: () => Promise<void>
  onShowAnswerPreview: (callback: () => void) => () => void
  getCurrentLlmConfig: () => Promise<{ provider: string; model: string }>
  getAvailableLlmModels: () => Promise<Array<{ id: string; name: string }>>
  setCurrentLlmModel: (model: string) => Promise<{ provider: string; model: string }>
  testLlmConnection: () => Promise<{ success: boolean; error?: string }>
  onLlmConfigChanged: (callback: (config: { provider: string; model: string }) => void) => () => void
  invoke: (channel: string, ...args: any[]) => Promise<any>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
