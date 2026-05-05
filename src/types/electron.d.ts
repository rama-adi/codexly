export interface ElectronAPI {
  platform: NodeJS.Platform
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (path: string) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (callback: (data: { path: string; preview: string }) => void) => () => void
  onSolutionsReady: (callback: (solutions: string) => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  takeScreenshot: () => Promise<void>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>
  analyzeImageFile: (path: string) => Promise<{ text: string; timestamp: number }>
  clearChatHistory: () => Promise<{ success: boolean }>
  quitApp: () => Promise<void>
  openSettingsWindow: () => Promise<void>
  closeSettingsWindow: () => Promise<void>
  minimizeSettingsWindow: () => Promise<void>
  setIgnoreMouseEvents: (ignore: boolean) => Promise<void>
  getStealthEnabled: () => Promise<{ stealthEnabled: boolean }>
  setStealthEnabled: (enabled: boolean) => Promise<{ stealthEnabled: boolean }>
  onStealthChanged: (callback: (config: { stealthEnabled: boolean }) => void) => () => void
  getAppSettings: () => Promise<AppSettings>
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  showAnswerPreview: () => Promise<void>
  onShowAnswerPreview: (callback: () => void) => () => void
  getCurrentLlmConfig: () => Promise<{ provider: string; model: string }>
  getAvailableLlmModels: () => Promise<Array<{ id: string; name: string }>>
  setCurrentLlmModel: (model: string) => Promise<{ provider: string; model: string }>
  testLlmConnection: () => Promise<{ success: boolean; error?: string }>
  onLlmConfigChanged: (callback: (config: { provider: string; model: string }) => void) => () => void
  invoke: (channel: string, ...args: any[]) => Promise<any>
}

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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
} 
