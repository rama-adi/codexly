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

/** Height, in pixels, reserved for the renderer-drawn titlebar overlay. */
const HOMEPAGE_TITLEBAR_HEIGHT = 52

function homepageTitleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
    }
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0b0f',
      symbolColor: '#e5e7eb',
      height: HOMEPAGE_TITLEBAR_HEIGHT,
    },
  }
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
    ...homepageTitleBarOptions(),
    webPreferences: secureWebPreferences(preloadPath),
  }
}

export function createOverlayWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 640,
    height: 64,
    minWidth: 360,
    minHeight: 48,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // macOS draws a jagged shadow/outline around a transparent window's alpha
    // shape that goes stale on resize; the renderer paints its own shadows.
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // A macOS panel floats above full-screen spaces without stealing focus.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
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
