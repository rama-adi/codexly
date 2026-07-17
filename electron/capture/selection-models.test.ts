import { describe, expect, it } from 'vitest'

import {
  logicalSelectionToPhysicalCrop,
  selectionFromDrag,
  type CaptureDisplay,
} from './selection-models'

const displays: readonly CaptureDisplay[] = [
  {
    id: 'left',
    label: 'Left',
    bounds: { x: -1280, y: -200, width: 1280, height: 1024 },
    workArea: { x: -1280, y: -200, width: 1280, height: 984 },
    scaleFactor: 1,
    rotation: 0,
    physicalSize: { width: 1280, height: 1024 },
  },
  {
    id: 'main',
    label: 'Main',
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1440, height: 860 },
    scaleFactor: 2,
    rotation: 0,
    physicalSize: { width: 2880, height: 1800 },
  },
]

describe('selection models', () => {
  it('pins the first drag point to one display and clamps crossing drags', () => {
    expect(selectionFromDrag(displays, { x: -100, y: 100 }, { x: 900, y: 800 })).toEqual({
      displayId: 'left',
      coordinateSpace: 'screen-dip',
      bounds: { x: -100, y: 100, width: 100, height: 700 },
    })
  })

  it('normalizes reverse drags on negative-origin displays', () => {
    expect(selectionFromDrag(displays, { x: -100, y: 500 }, { x: -500, y: 100 }).bounds).toEqual({
      x: -500,
      y: 100,
      width: 400,
      height: 400,
    })
  })

  it('converts logical coordinates using actual captured pixel ratios', () => {
    expect(logicalSelectionToPhysicalCrop({
      displayId: 'main',
      coordinateSpace: 'screen-dip',
      bounds: { x: 100.2, y: 50.2, width: 200.1, height: 100.1 },
    }, displays[1], { width: 2879, height: 1799 })).toEqual({
      x: 200,
      y: 100,
      width: 401,
      height: 201,
    })
  })

  it('rejects a selection associated with another display', () => {
    expect(() => logicalSelectionToPhysicalCrop({
      displayId: 'left',
      coordinateSpace: 'screen-dip',
      bounds: { x: 10, y: 10, width: 20, height: 20 },
    }, displays[1])).toThrow('different display')
  })
})
