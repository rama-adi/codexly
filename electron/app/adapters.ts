import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  MessageChannelMain,
  nativeImage,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type NativeImage,
} from 'electron'
import os from 'node:os'

import type { SafeStorageAdapter } from '../auth/credential-store'
import type { CaptureImage, ScreenCaptureSource } from '../capture/display-capture'
import type {
  CaptureDisplay,
  CaptureTarget,
  Point,
  Rectangle,
  Size,
} from '../capture/selection-models'
import {
  createSelectionSurface,
  type SelectionSurfaceResult,
} from '../capture/selection-surface'
import type { GlobalShortcutAdapter } from '../shortcuts/shortcut-manager'

/**
 * The main process' entire dependency on Electron and the host machine, stated
 * as hand-written structural types. Nothing here imports an Electron type into
 * an interface, so every collaborator below can be substituted by a plain
 * object in a node test — see {@link createElectronAdapters} for the real one.
 */
export interface MainProcessAdapters {
  screen: ScreenAdapter
  captureSources: CaptureSourcesAdapter
  dialog: DialogAdapter
  shell: ShellAdapter
  safeStorage: SafeStorageAdapter
  globalShortcut: GlobalShortcutAdapter
  systemPreferences: SystemPreferencesAdapter
  image: ImageAdapter
  selection: SelectionAdapter
  clock: ClockAdapter
  env: EnvironmentAdapter
}

/** One display as the host reports it, before normalization. */
export interface ScreenDisplay {
  id: string
  label: string
  bounds: Rectangle
  workArea: Rectangle
  scaleFactor: number
  rotation: number
}

export interface ScreenAdapter {
  getAllDisplays(): readonly ScreenDisplay[]
  getCursorPoint(): Point
  /** The id of the display that best contains the given bounds. */
  getDisplayIdMatching(bounds: Rectangle): string
}

export interface CaptureSourcesAdapter {
  getSources(thumbnailSize: Size): Promise<readonly ScreenCaptureSource[]>
}

export type MessageBoxKind = 'none' | 'info' | 'error' | 'question' | 'warning'

export interface MessageBoxRequest {
  type: MessageBoxKind
  buttons: readonly string[]
  defaultId: number
  cancelId: number
  title: string
  message: string
  detail: string
}

export interface DialogAdapter {
  /** Native directory picker; the only trusted source of workspace paths. */
  openDirectory(): Promise<{ canceled: boolean; filePaths: readonly string[] }>
  showMessageBoxSync(request: MessageBoxRequest): number
}

export interface ShellAdapter {
  openExternal(url: string): Promise<void>
}

export interface SystemPreferencesAdapter {
  getMediaAccessStatus(media: 'screen'): string
}

/** A bounded, resizable image used to build attachment previews. */
export interface PreviewImage {
  getSize(): Size
  resize(options: {
    width: number
    height: number
    quality: 'good' | 'better' | 'best'
  }): PreviewImage
  toDataURL(): string
}

export interface ImageAdapter {
  createFromBuffer(bytes: Buffer): PreviewImage
}

export interface SelectionAdapter {
  selectRegion(
    displays: readonly CaptureDisplay[],
    signal: AbortSignal,
  ): Promise<CaptureTarget | 'cancelled'>
  dispose(): void
}

export interface ClockAdapter {
  now(): Date
}

export interface EnvironmentAdapter {
  readonly platform: string
  homedir(): string
  readEnv(name: string): string | undefined
}

/**
 * The real adapters. Every Electron value is touched lazily inside a method, so
 * importing this module never reaches into the Electron runtime — which is what
 * lets the whole main process be imported by a plain node test.
 */
export function createElectronAdapters(
  overrides: Partial<MainProcessAdapters> = {},
): MainProcessAdapters {
  const selectionSurface = createSelectionSurface({
    createWindow: (options) => new BrowserWindow(options),
    createChannel: () => new MessageChannelMain(),
    getCursorPoint: () => screen.getCursorScreenPoint(),
  })
  const selection: SelectionAdapter = {
    selectRegion: (displays, signal): Promise<SelectionSurfaceResult> =>
      selectionSurface.select(displays, signal),
    dispose: () => selectionSurface.dispose(),
  }

  return {
    screen: {
      getAllDisplays: () =>
        screen.getAllDisplays().map((display) => ({
          id: String(display.id),
          label: display.label || `Display ${display.id}`,
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
          rotation: display.rotation,
        })),
      getCursorPoint: () => screen.getCursorScreenPoint(),
      getDisplayIdMatching: (bounds) => String(screen.getDisplayMatching(bounds).id),
    },
    captureSources: {
      getSources: async (thumbnailSize) =>
        (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })).map(
          (source): ScreenCaptureSource => ({
            id: source.id,
            displayId: source.display_id || null,
            name: source.name,
            image: wrapNativeImage(source.thumbnail),
          }),
        ),
    },
    dialog: {
      openDirectory: () => dialog.showOpenDialog({ properties: ['openDirectory'] }),
      showMessageBoxSync: (request) =>
        dialog.showMessageBoxSync({ ...request, buttons: [...request.buttons] }),
    },
    shell: {
      openExternal: (url) => shell.openExternal(url),
    },
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    },
    globalShortcut: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    systemPreferences: {
      getMediaAccessStatus: (media) => systemPreferences.getMediaAccessStatus(media),
    },
    image: {
      createFromBuffer: (bytes) => nativeImage.createFromBuffer(bytes),
    },
    selection,
    clock: { now: () => new Date() },
    env: {
      platform: process.platform,
      homedir: () => os.homedir(),
      readEnv: (name) => process.env[name],
    },
    ...overrides,
  }
}

/** Releases the host resources the real adapters own (selector windows). */
export function registerAdapterTeardown(adapters: MainProcessAdapters): void {
  app.once('before-quit', () => adapters.selection.dispose())
}

function wrapNativeImage(image: NativeImage): CaptureImage {
  return {
    size: image.getSize(),
    toPng: () => image.toPNG(),
    crop: (bounds: Rectangle) => wrapNativeImage(image.crop(bounds)),
  }
}
