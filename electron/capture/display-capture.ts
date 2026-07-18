import type { DesktopCapturerSource, Display, NativeImage } from 'electron'

import {
  displayAtPoint,
  logicalSelectionToPhysicalCrop,
  type CaptureDisplay,
  type CaptureTarget,
  type DisplayRotation,
  type Point,
  type Rectangle,
  type Size,
} from './selection-models'

export interface CaptureImage {
  readonly size: Size
  toPng(): Buffer
  crop(bounds: Rectangle): CaptureImage
}

export interface ScreenCaptureSource {
  readonly id: string
  readonly displayId: string | null
  readonly name: string
  readonly image: CaptureImage
}

export interface DisplayCaptureAdapter {
  getAllDisplays(): readonly CaptureDisplay[]
  getCursorPoint(): Point
  getSources(thumbnailSize: Size): Promise<readonly ScreenCaptureSource[]>
}

export type DisplayChoice =
  | Readonly<{ kind: 'cursor' }>
  | Readonly<{ kind: 'overlay'; bounds: Rectangle }>
  | Readonly<{ kind: 'id'; displayId: string }>

export type CapturedImage = Readonly<{
  bytes: Buffer
  mimeType: 'image/png'
  pixelSize: Size
  display: CaptureDisplay
  target: CaptureTarget
}>

export class DisplayCaptureError extends Error {
  constructor(
    readonly code:
      | 'display-not-found'
      | 'no-sources'
      | 'source-not-found'
      | 'source-ambiguous'
      | 'empty-image',
    message: string,
  ) {
    super(message)
    this.name = 'DisplayCaptureError'
  }
}

export class DisplayCapture {
  constructor(private readonly adapter: DisplayCaptureAdapter) {}

  snapshotTopology(): readonly CaptureDisplay[] {
    return [...this.adapter.getAllDisplays()]
  }

  listDisplays(): readonly CaptureDisplay[] {
    return this.snapshotTopology()
  }

  resolveDisplay(
    choice: DisplayChoice,
    displays: readonly CaptureDisplay[] = this.snapshotTopology(),
  ): CaptureDisplay {
    let display: CaptureDisplay | null = null

    if (choice.kind === 'id') {
      display = displays.find((candidate) => candidate.id === choice.displayId) ?? null
    } else if (choice.kind === 'cursor') {
      display = displayAtPoint(displays, this.adapter.getCursorPoint())
    } else {
      const center = {
        x: choice.bounds.x + choice.bounds.width / 2,
        y: choice.bounds.y + choice.bounds.height / 2,
      }
      display = displayAtPoint(displays, center)
    }

    if (!display) {
      throw new DisplayCaptureError('display-not-found', 'No display matches the capture location.')
    }
    return display
  }

  async capture(
    target: CaptureTarget,
    signal?: AbortSignal,
    displays: readonly CaptureDisplay[] = this.snapshotTopology(),
  ): Promise<CapturedImage> {
    throwIfAborted(signal)
    const displayId = target.kind === 'display' ? target.displayId : target.selection.displayId
    const display = displays.find((candidate) => candidate.id === displayId)
    if (!display) {
      throw new DisplayCaptureError('display-not-found', `Display ${displayId} is unavailable.`)
    }

    const sources = await this.adapter.getSources(display.physicalSize)
    throwIfAborted(signal)
    if (sources.length === 0) {
      // macOS reports 'granted' yet returns no sources when the Screen
      // Recording permission has gone stale; only re-granting fixes it.
      throw new DisplayCaptureError(
        'no-sources',
        'Screen capture returned no displays. Re-enable Screen Recording for this app in System Settings → Privacy & Security, then relaunch.',
      )
    }
    const source = matchSource(display, displays, sources)
    let image = source.image

    if (target.kind === 'selection') {
      const crop = logicalSelectionToPhysicalCrop(target.selection, display, image.size)
      image = image.crop(crop)
    }

    const bytes = image.toPng()
    if (bytes.byteLength === 0 || image.size.width <= 0 || image.size.height <= 0) {
      throw new DisplayCaptureError('empty-image', 'The display capture returned an empty image.')
    }

    return {
      bytes,
      mimeType: 'image/png',
      pixelSize: image.size,
      display,
      target,
    }
  }
}

export async function createElectronDisplayCaptureAdapter(): Promise<DisplayCaptureAdapter> {
  const { desktopCapturer, screen } = await import('electron')
  return {
    getAllDisplays: () => screen.getAllDisplays().map(mapElectronDisplay),
    getCursorPoint: () => screen.getCursorScreenPoint(),
    getSources: async (thumbnailSize) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        fetchWindowIcons: false,
        thumbnailSize,
      })
      return sources.map(mapElectronSource)
    },
  }
}

function mapElectronDisplay(display: Display): CaptureDisplay {
  const scaleFactor = display.scaleFactor
  const rotation = normalizeRotation(display.rotation)
  return {
    id: String(display.id),
    label: display.label || `Display ${display.id}`,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor,
    rotation,
    physicalSize: physicalSize(display.bounds, scaleFactor),
  }
}

function physicalSize(bounds: Rectangle, scaleFactor: number): Size {
  return {
    width: Math.round(bounds.width * scaleFactor),
    height: Math.round(bounds.height * scaleFactor),
  }
}

function normalizeRotation(rotation: number): DisplayRotation {
  const normalized = ((rotation % 360) + 360) % 360
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized
  }
  return 0
}

function mapElectronSource(source: DesktopCapturerSource): ScreenCaptureSource {
  return {
    id: source.id,
    displayId: source.display_id || null,
    name: source.name,
    image: wrapNativeImage(source.thumbnail),
  }
}

function wrapNativeImage(image: NativeImage): CaptureImage {
  const size = image.getSize()
  return {
    size,
    toPng: () => image.toPNG(),
    crop: (bounds) => wrapNativeImage(image.crop(bounds)),
  }
}

function matchSource(
  display: CaptureDisplay,
  displays: readonly CaptureDisplay[],
  sources: readonly ScreenCaptureSource[],
): ScreenCaptureSource {
  const matches = sources.filter((source) => source.displayId === display.id)
  if (matches.length === 1) {
    return matches[0]
  }
  if (matches.length > 1) {
    throw new DisplayCaptureError('source-ambiguous', `Multiple sources match display ${display.id}.`)
  }
  if (displays.length === 1 && sources.length === 1) {
    return sources[0]
  }
  // Newer macOS releases often report screen sources with an empty display_id
  // (Electron #41585). Screen source order mirrors screen.getAllDisplays(), so
  // fall back to positional matching when no source carries an id.
  if (
    sources.length === displays.length &&
    sources.every((source) => source.displayId === null)
  ) {
    const index = displays.findIndex((candidate) => candidate.id === display.id)
    if (index >= 0) {
      return sources[index]
    }
  }
  throw new DisplayCaptureError('source-not-found', `No source matches display ${display.id}.`)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Capture cancelled.', 'AbortError')
  }
}
