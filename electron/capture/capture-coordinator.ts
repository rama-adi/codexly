import type { AttachmentRecord, AttachmentStore } from './attachment-store'
import { logger } from '../shared/logger'

const log = logger.child('capture')

/** The attachment-store surface a capture needs; keeps the store substitutable. */
export type CaptureAttachmentSink = Pick<
  AttachmentStore,
  'addPendingImage' | 'discardPending'
>
import type { CapturedImage, DisplayCapture } from './display-capture'
import type { CaptureDisplay, CaptureTarget, Rectangle } from './selection-models'

export type CaptureWindowState = Readonly<{
  visible: boolean
  focused: boolean
  clickThrough: boolean
  displayId: string
  bounds: Rectangle
}>

export type CapturePresentationSnapshot = Readonly<{
  homepage: CaptureWindowState
  overlay: CaptureWindowState
}>

export interface CapturePresentationAdapter {
  snapshot(): Promise<CapturePresentationSnapshot>
  prepareForCapture(snapshot: CapturePresentationSnapshot): Promise<void>
  restore(snapshot: CapturePresentationSnapshot): Promise<void>
}

export type CaptureRequest = Readonly<{
  selectTarget(
    signal: AbortSignal,
    displays: readonly CaptureDisplay[],
  ): Promise<CaptureTarget>
}>

export type CaptureOutcome =
  | Readonly<{
      kind: 'captured'
      attachment: AttachmentRecord
      image: Omit<CapturedImage, 'bytes'>
    }>
  | Readonly<{ kind: 'cancelled' }>

export class CaptureBusyError extends Error {
  constructor() {
    super('A capture is already in progress.')
    this.name = 'CaptureBusyError'
  }
}

export class CaptureCancelledError extends Error {
  constructor(message = 'Capture cancelled.') {
    super(message)
    this.name = 'CaptureCancelledError'
  }
}

export class CaptureRestorationError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super('Capture failed and presentation restoration also failed.')
    this.name = 'CaptureRestorationError'
  }
}

export class CaptureCoordinator {
  private activeAbortController: AbortController | null = null

  constructor(
    private readonly displayCapture: DisplayCapture,
    private readonly attachmentStore: CaptureAttachmentSink,
    private readonly presentation: CapturePresentationAdapter,
  ) {}

  get capturing(): boolean {
    return this.activeAbortController !== null
  }

  cancel(): boolean {
    if (!this.activeAbortController) {
      return false
    }
    this.activeAbortController.abort(new CaptureCancelledError())
    return true
  }

  async capture(request: CaptureRequest): Promise<CaptureOutcome> {
    if (this.activeAbortController) {
      throw new CaptureBusyError()
    }

    const abortController = new AbortController()
    this.activeAbortController = abortController
    let snapshot: CapturePresentationSnapshot | null = null
    let operationError: unknown
    let outcome: CaptureOutcome | undefined

    let restoreError: unknown
    try {
      // Timings for the user-visible latency of a capture: everything before
      // `selected` runs while the user is still waiting to see the selector.
      const startedAt = Date.now()
      let preparedAt = startedAt
      try {
        snapshot = await this.presentation.snapshot()
        await this.presentation.prepareForCapture(snapshot)
        preparedAt = Date.now()
        throwIfAborted(abortController.signal)
        const displays = this.displayCapture.snapshotTopology()
        const target = await request.selectTarget(abortController.signal, displays)
        const selectedAt = Date.now()
        throwIfAborted(abortController.signal)
        const image = await this.displayCapture.capture(
          target,
          abortController.signal,
          displays,
        )
        log.debug('capture timings', {
          // Time spent hiding our own windows before the selector can appear.
          prepareMs: preparedAt - startedAt,
          // Includes the user's drag; the surface logs the show latency itself.
          selectWithUserMs: selectedAt - preparedAt,
          grabMs: Date.now() - selectedAt,
        })
        throwIfAborted(abortController.signal)
        const attachment = await this.attachmentStore.addPendingImage({
          bytes: image.bytes,
          mimeType: image.mimeType,
          width: image.pixelSize.width,
          height: image.pixelSize.height,
          name: screenshotName(),
        })
        if (abortController.signal.aborted) {
          await this.attachmentStore.discardPending(attachment.id)
          throwIfAborted(abortController.signal)
        }
        const { bytes: _bytes, ...imageMetadata } = image
        void _bytes
        outcome = { kind: 'captured', attachment, image: imageMetadata }
      } catch (error) {
        operationError = error
      }
    } finally {
      if (snapshot) {
        try {
          await this.presentation.restore(snapshot)
        } catch (error) {
          restoreError = error
        }
      }
      this.activeAbortController = null
    }

    if (restoreError !== undefined) {
      if (operationError !== undefined) {
        throw new CaptureRestorationError([operationError, restoreError])
      }
      throw restoreError
    }
    if (operationError !== undefined) {
      if (isCancellation(operationError, abortController.signal)) {
        return { kind: 'cancelled' }
      }
      throw operationError
    }
    if (!outcome) {
      throw new Error('Capture completed without an outcome.')
    }
    return outcome
  }
}

function screenshotName(): string {
  return `Screenshot ${new Date().toISOString().replace(/:/g, '-')}.png`
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new CaptureCancelledError()
  }
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    error instanceof CaptureCancelledError ||
    (signal.aborted && error === signal.reason) ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}
