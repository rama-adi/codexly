import { describe, expect, it, vi } from 'vitest'

import type { AttachmentRecord, AttachmentStore } from './attachment-store'
import {
  CaptureBusyError,
  CaptureCancelledError,
  CaptureCoordinator,
  CaptureRestorationError,
  type CapturePresentationAdapter,
  type CapturePresentationSnapshot,
} from './capture-coordinator'
import type { CapturedImage, DisplayCapture } from './display-capture'
import type { CaptureTarget } from './selection-models'

const snapshot: CapturePresentationSnapshot = {
  homepage: {
    visible: true,
    focused: true,
    clickThrough: false,
    displayId: '1',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  },
  overlay: {
    visible: true,
    focused: false,
    clickThrough: true,
    displayId: '2',
    bounds: { x: -500, y: 100, width: 400, height: 100 },
  },
}

const target: CaptureTarget = { kind: 'display', displayId: '1' }
const image: CapturedImage = {
  bytes: Buffer.from('image'),
  mimeType: 'image/png',
  pixelSize: { width: 10, height: 10 },
  display: {
    id: '1',
    label: 'Display',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    workArea: { x: 0, y: 0, width: 10, height: 10 },
    scaleFactor: 1,
    rotation: 0,
    physicalSize: { width: 10, height: 10 },
  },
  target,
}
const attachment: AttachmentRecord = {
  id: '00000000-0000-4000-8000-000000000000',
  name: 'capture.png',
  mimeType: 'image/png',
  byteSize: 5,
  width: 10,
  height: 10,
  createdAt: '2026-07-18T12:00:00.000Z',
  associations: [],
}

function presentation(events: string[]): CapturePresentationAdapter {
  return {
    snapshot: async () => {
      events.push('snapshot')
      return snapshot
    },
    prepareForCapture: async () => {
      events.push('prepare')
    },
    restore: async (received) => {
      expect(received).toEqual(snapshot)
      events.push('restore')
    },
  }
}

function coordinator(
  events: string[],
  capture = vi.fn(async () => {
    events.push('capture')
    return image
  }),
  addPendingImage = vi.fn(async () => {
    events.push('store')
    return attachment
  }),
  discardPending = vi.fn(async () => true),
  presentationAdapter = presentation(events),
): CaptureCoordinator {
  return new CaptureCoordinator(
    { capture, snapshotTopology: () => [image.display] } as unknown as DisplayCapture,
    { addPendingImage, discardPending } as unknown as AttachmentStore,
    presentationAdapter,
  )
}

describe('CaptureCoordinator', () => {
  it('restores the exact presentation snapshot after success', async () => {
    const events: string[] = []
    const result = await coordinator(events).capture({ selectTarget: async () => target })
    expect(result.kind).toBe('captured')
    expect(events).toEqual(['snapshot', 'prepare', 'capture', 'store', 'restore'])
  })

  it('uses one display topology snapshot for selection and capture', async () => {
    const events: string[] = []
    const topology = [image.display]
    const capture = vi.fn(async (
      _target: CaptureTarget,
      _signal: AbortSignal,
      displays: readonly typeof image.display[],
    ) => {
      expect(displays).toBe(topology)
      return image
    })
    const service = new CaptureCoordinator(
      { capture, snapshotTopology: () => topology } as unknown as DisplayCapture,
      {
        addPendingImage: async () => attachment,
        discardPending: async () => true,
      } as unknown as AttachmentStore,
      presentation(events),
    )

    await service.capture({
      selectTarget: async (_signal, displays) => {
        expect(displays).toBe(topology)
        return target
      },
    })
    expect(capture).toHaveBeenCalledOnce()
  })

  it('restores presentation after capture failure', async () => {
    const events: string[] = []
    const failure = new Error('capture failed')
    const service = coordinator(events, vi.fn(async () => {
      events.push('capture')
      throw failure
    }))
    await expect(service.capture({ selectTarget: async () => target })).rejects.toBe(failure)
    expect(events).toEqual(['snapshot', 'prepare', 'capture', 'restore'])
  })

  it('surfaces restoration failure and preserves an earlier operation failure', async () => {
    const events: string[] = []
    const operationFailure = new Error('capture failed')
    const restoreFailure = new Error('restore failed')
    const presentationAdapter = presentation(events)
    presentationAdapter.restore = async () => {
      events.push('restore')
      throw restoreFailure
    }
    const service = coordinator(
      events,
      vi.fn(async () => {
        events.push('capture')
        throw operationFailure
      }),
      undefined,
      undefined,
      presentationAdapter,
    )

    const error = await service
      .capture({ selectTarget: async () => target })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CaptureRestorationError)
    expect((error as CaptureRestorationError).errors).toEqual([
      operationFailure,
      restoreFailure,
    ])
    expect(service.capturing).toBe(false)
    expect(events).toEqual(['snapshot', 'prepare', 'capture', 'restore'])
  })

  it('rejects with restoration failure after an otherwise successful capture', async () => {
    const events: string[] = []
    const restoreFailure = new Error('restore failed')
    const presentationAdapter = presentation(events)
    presentationAdapter.restore = async () => {
      throw restoreFailure
    }
    const service = coordinator(
      events,
      undefined,
      undefined,
      undefined,
      presentationAdapter,
    )

    await expect(
      service.capture({ selectTarget: async () => target }),
    ).rejects.toBe(restoreFailure)
    expect(service.capturing).toBe(false)
  })

  it('returns a distinct cancellation outcome and restores presentation', async () => {
    const events: string[] = []
    const service = coordinator(events)
    const outcome = await service.capture({
      selectTarget: async () => {
        throw new CaptureCancelledError()
      },
    })
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(events).toEqual(['snapshot', 'prepare', 'restore'])
  })

  it('rejects repeated capture while the mutex is held', async () => {
    const events: string[] = []
    let releaseSelection: ((selected: CaptureTarget) => void) | undefined
    const service = coordinator(events)
    const first = service.capture({
      selectTarget: () => new Promise((resolve) => {
        releaseSelection = resolve
      }),
    })
    await vi.waitFor(() => expect(releaseSelection).toBeDefined())
    await expect(service.capture({ selectTarget: async () => target })).rejects.toBeInstanceOf(CaptureBusyError)
    releaseSelection?.(target)
    await first
  })

  it('keeps the mutex held until presentation restoration finishes', async () => {
    const events: string[] = []
    let finishRestore: (() => void) | undefined
    const presentationAdapter = presentation(events)
    presentationAdapter.restore = async () => new Promise((resolve) => {
      finishRestore = resolve
    })
    const service = coordinator(
      events,
      undefined,
      undefined,
      undefined,
      presentationAdapter,
    )
    const first = service.capture({ selectTarget: async () => target })
    await vi.waitFor(() => expect(finishRestore).toBeDefined())
    await expect(service.capture({ selectTarget: async () => target })).rejects.toBeInstanceOf(CaptureBusyError)
    finishRestore?.()
    await first
  })

  it('discards an attachment when cancellation arrives during storage', async () => {
    const events: string[] = []
    let finishStore: ((stored: AttachmentRecord) => void) | undefined
    const discardPending = vi.fn(async () => true)
    const service = coordinator(
      events,
      undefined,
      vi.fn(() => new Promise((resolve) => {
        finishStore = resolve
      })),
      discardPending,
    )
    const pending = service.capture({ selectTarget: async () => target })
    await vi.waitFor(() => expect(finishStore).toBeDefined())
    service.cancel()
    finishStore?.(attachment)

    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(discardPending).toHaveBeenCalledWith(attachment.id)
    expect(events[events.length - 1]).toBe('restore')
  })

  it('aborts the active selection and restores presentation', async () => {
    const events: string[] = []
    const service = coordinator(events)
    const pending = service.capture({
      selectTarget: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    await vi.waitFor(() => expect(service.capturing).toBe(true))
    expect(service.cancel()).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(events[events.length - 1]).toBe('restore')
  })
})
