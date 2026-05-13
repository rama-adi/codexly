import type { AppBridge } from "@/shared/ipc"

export type {
  AppSettings,
  ChatSession,
  CodexReadyStatus,
  DirectoryProfile,
  HistoryIndexItem,
  PersonalizationConfig,
} from "@/shared/ipc"

declare global {
  interface Window {
    appBridge: AppBridge
  }
}
