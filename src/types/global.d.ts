import type { CodexlyDesktopBridge } from './desktop-bridge'

declare global {
  interface Window {
    readonly codexly?: CodexlyDesktopBridge
  }
}

export {}
