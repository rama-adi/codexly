import { describe, expect, it } from 'vitest'

import {
  DisplayCapture,
  DisplayCaptureError,
  type CaptureImage,
  type DisplayCaptureAdapter,
} from './display-capture'
import type { CaptureDisplay, Rectangle } from './selection-models'

const display: CaptureDisplay = {
  id: '7',
  label: 'Mixed DPI',
  bounds: { x: -1000, y: 100, width: 1000, height: 800 },
  workArea: { x: -1000, y: 100, width: 1000, height: 760 },
  scaleFactor: 1.5,
  rotation: 0,
  physicalSize: { width: 1500, height: 1200 },
}

function image(size = display.physicalSize, crops: Rectangle[] = []): CaptureImage {
  return {
    size,
    toPng: () => Buffer.from('png'),
    crop: (bounds) => {
      crops.push(bounds)
      return image({ width: bounds.width, height: bounds.height }, crops)
    },
  }
}

function adapter(overrides: Partial<DisplayCaptureAdapter> = {}): DisplayCaptureAdapter {
  return {
    getAllDisplays: () => [display],
    getCursorPoint: () => ({ x: -500, y: 500 }),
    getSources: async () => [{ id: 'screen:7', displayId: '7', name: 'screen', image: image() }],
    ...overrides,
  }
}

describe('DisplayCapture', () => {
  it('resolves displays under the cursor and overlay center', () => {
    const capture = new DisplayCapture(adapter())
    expect(capture.resolveDisplay({ kind: 'cursor' }).id).toBe('7')
    expect(capture.resolveDisplay({ kind: 'overlay', bounds: { x: -800, y: 200, width: 200, height: 200 } }).id).toBe('7')
  })

  it('captures all display metadata and crops with logical-to-physical math', async () => {
    const crops: Rectangle[] = []
    const capture = new DisplayCapture(adapter({
      getSources: async () => [{ id: 'source', displayId: '7', name: 'screen', image: image(display.physicalSize, crops) }],
    }))
    const result = await capture.capture({
      kind: 'selection',
      selection: {
        displayId: '7',
        coordinateSpace: 'screen-dip',
        bounds: { x: -900, y: 200, width: 200, height: 100 },
      },
    })
    expect(crops).toEqual([{ x: 150, y: 150, width: 300, height: 150 }])
    expect(result.display).toEqual(display)
    expect(result.pixelSize).toEqual({ width: 300, height: 150 })
  })

  it('falls back to positional matching when macOS omits every display_id', async () => {
    const second = { ...display, id: '8', bounds: { ...display.bounds, x: 0 } }
    const capture = new DisplayCapture(adapter({
      getAllDisplays: () => [display, second],
      getSources: async () => [
        { id: 'screen:0', displayId: null, name: 'Display 1', image: image() },
        { id: 'screen:1', displayId: null, name: 'Display 2', image: image() },
      ],
    }))
    const result = await capture.capture({ kind: 'display', displayId: '8' })
    expect(result.display.id).toBe('8')
  })

  it('does not guess among sources on multiple displays', async () => {
    const capture = new DisplayCapture(adapter({
      getAllDisplays: () => [display, { ...display, id: '8' }],
      getSources: async () => [{ id: 'unknown', displayId: null, name: 'screen', image: image() }],
    }))
    await expect(capture.capture({ kind: 'display', displayId: '7' })).rejects.toEqual(
      expect.objectContaining<Partial<DisplayCaptureError>>({ code: 'source-not-found' }),
    )
  })
})
