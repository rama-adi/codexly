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
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  webSearchEnabled: boolean
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

export interface CodexReadyStatus {
  state: "idle" | "warming" | "ready" | "error"
  key: string
  model: string
  cwd?: string
  threadId?: string | null
  error?: string
}

export interface LlmModelOption {
  id: string
  model: string
  name: string
  displayName: string
  hidden: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description?: string
  }>
  inputModalities: string[]
  supportsPersonality: boolean
  isDefault: boolean
  upgrade?: string
  upgradeInfo?: unknown
}

export interface ScreenshotPreview {
  path: string
  preview: string
}

export interface AppBridge {
  platform: NodeJS.Platform
  layout: {
    updateContentDimensions: (dimensions: { width: number; height: number }) => Promise<void>
    setIgnoreMouseEvents: (ignore: boolean) => Promise<void>
  }
  screenshots: {
    take: () => Promise<ScreenshotPreview>
    list: () => Promise<ScreenshotPreview[]>
    delete: (path: string) => Promise<{ success: boolean; error?: string }>
    clear: () => Promise<{ success: boolean }>
    resetQueues: () => Promise<{ success: boolean; error?: string }>
    onTaken: (callback: (data: ScreenshotPreview) => void) => () => void
    onCleared: (callback: () => void) => () => void
    onBufferCleared: (callback: () => void) => () => void
  }
  processing: {
    chat: (message: string) => Promise<string>
    clearChatHistory: () => Promise<{ success: boolean }>
    clearChatSessions: () => Promise<{ success: boolean }>
    startToolbarSession: () => Promise<CodexReadyStatus>
    prepareCodex: () => Promise<CodexReadyStatus>
    getCodexReadyStatus: () => Promise<CodexReadyStatus>
    showAnswerPreview: () => Promise<void>
    onResetView: (callback: () => void) => () => void
    onSolutionStreamStart: (callback: () => void) => () => void
    onSolutionStreamDelta: (callback: (delta: string) => void) => () => void
    onSolutionStreamComplete: (callback: (data: { answer: string }) => void) => () => void
    onSolutionStreamError: (callback: (error: string) => void) => () => void
    onChatStreamStart: (callback: () => void) => () => void
    onChatStreamDelta: (callback: (delta: string) => void) => () => void
    onChatStreamComplete: (callback: (data: { answer: string }) => void) => () => void
    onChatStreamError: (callback: (error: string) => void) => () => void
    onNoScreenshots: (callback: () => void) => () => void
    onUnauthorized: (callback: () => void) => () => void
    onReadyStatusChanged: (callback: (status: CodexReadyStatus) => void) => () => void
    onShowAnswerPreview: (callback: () => void) => () => void
  }
  shell: {
    quitApp: () => Promise<void>
    closeCurrentWindow: () => Promise<void>
    minimizeCurrentWindow: () => Promise<void>
    openSettingsWindow: () => Promise<void>
    closeSettingsWindow: () => Promise<void>
    minimizeSettingsWindow: () => Promise<void>
    showMainWindow: () => Promise<void>
    hideMainWindow: () => Promise<void>
    toggleMainWindow: () => Promise<void>
    toggleCurrentWindowMaximize: () => Promise<void>
    moveWindowLeft: () => Promise<void>
    moveWindowRight: () => Promise<void>
    moveWindowUp: () => Promise<void>
    moveWindowDown: () => Promise<void>
    pickWorkingDirectory: (options?: { initialPath?: string }) => Promise<string | null>
    openDirectory: (path: string) => Promise<{ success: boolean; error?: string }>
  }
  settings: {
    getStealthEnabled: () => Promise<{ stealthEnabled: boolean }>
    setStealthEnabled: (enabled: boolean) => Promise<{ stealthEnabled: boolean }>
    getAppSettings: () => Promise<AppSettings>
    updateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
    onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) => () => void
    onAppSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  }
  personalization: {
    get: () => Promise<PersonalizationConfig>
    update: (patch: Partial<PersonalizationConfig>) => Promise<PersonalizationConfig>
    onChanged: (callback: (config: PersonalizationConfig) => void) => () => void
  }
  history: {
    getIndex: () => Promise<HistoryIndexItem[]>
    getSession: (sessionId: string) => Promise<ChatSession | null>
    getActiveSession: () => Promise<ChatSession | null>
    activateSession: (sessionId: string) => Promise<ChatSession | null>
    deleteSession: (sessionId: string) => Promise<{ success: boolean }>
    newSession: () => Promise<ChatSession>
    onChanged: (callback: (history: HistoryIndexItem[]) => void) => () => void
  }
  llm: {
    getCurrentConfig: () => Promise<{ provider: string; model: string }>
    getAvailableModels: () => Promise<LlmModelOption[]>
    setCurrentModel: (model: string) => Promise<{ provider: string; model: string }>
    testConnection: () => Promise<{ success: boolean; error?: string }>
    onConfigChanged: (callback: (config: { provider: string; model: string }) => void) => () => void
  }
}
