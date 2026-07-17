import type { BrowserWindowConstructorOptions, LoadFileOptions } from 'electron'

export const WINDOW_ROLE_QUERY_PARAMETER = 'role'

export const WINDOW_ROLES = ['homepage', 'overlay'] as const

export type WindowRole = (typeof WINDOW_ROLES)[number]

export interface RendererTarget {
  filePath?: string
  fileOptions?: LoadFileOptions
  url?: string
}

const secureWebPreferences = (preloadPath: string) => ({
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
})

export function sanitizeWindowRole(value: unknown): WindowRole {
  return value === 'overlay' ? 'overlay' : 'homepage'
}

export function createHomepageWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    show: true,
    title: 'Codexly',
    webPreferences: secureWebPreferences(preloadPath),
  }
}

export function createOverlayWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 480,
    height: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: secureWebPreferences(preloadPath),
  }
}

export function createRendererTarget(
  roleValue: unknown,
  devServerUrl: string | undefined,
  rendererHtmlPath: string,
): RendererTarget {
  const role = sanitizeWindowRole(roleValue)

  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.searchParams.set(WINDOW_ROLE_QUERY_PARAMETER, role)

    return { url: url.toString() }
  }

  return {
    filePath: rendererHtmlPath,
    fileOptions: {
      query: {
        [WINDOW_ROLE_QUERY_PARAMETER]: role,
      },
    },
  }
}
