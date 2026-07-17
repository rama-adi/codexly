export type Point = Readonly<{ x: number; y: number }>
export type Size = Readonly<{ width: number; height: number }>
export type Rectangle = Readonly<Point & Size>

export type DisplayRotation = 0 | 90 | 180 | 270

export type CaptureDisplay = Readonly<{
  id: string
  label: string
  bounds: Rectangle
  workArea: Rectangle
  scaleFactor: number
  rotation: DisplayRotation
  physicalSize: Size
}>

export type DisplaySelection = Readonly<{
  displayId: string
  bounds: Rectangle
  coordinateSpace: 'screen-dip'
}>

export type CaptureTarget =
  | Readonly<{ kind: 'display'; displayId: string }>
  | Readonly<{ kind: 'selection'; selection: DisplaySelection }>

export function containsPoint(rectangle: Rectangle, point: Point): boolean {
  return (
    point.x >= rectangle.x &&
    point.y >= rectangle.y &&
    point.x < rectangle.x + rectangle.width &&
    point.y < rectangle.y + rectangle.height
  )
}

export function displayAtPoint(
  displays: readonly CaptureDisplay[],
  point: Point,
): CaptureDisplay | null {
  return displays.find((display) => containsPoint(display.bounds, point)) ?? null
}

/** Creates a drag selection pinned to the display containing its first point. */
export function selectionFromDrag(
  displays: readonly CaptureDisplay[],
  anchor: Point,
  current: Point,
): DisplaySelection {
  const display = displayAtPoint(displays, anchor)
  if (!display) {
    throw new Error('The selection must start on a known display.')
  }

  const right = display.bounds.x + display.bounds.width
  const bottom = display.bounds.y + display.bounds.height
  const clamped = {
    x: clamp(current.x, display.bounds.x, right),
    y: clamp(current.y, display.bounds.y, bottom),
  }

  return {
    displayId: display.id,
    coordinateSpace: 'screen-dip',
    bounds: normalizeRectangle(anchor, clamped),
  }
}

export function normalizeRectangle(first: Point, second: Point): Rectangle {
  const x = Math.min(first.x, second.x)
  const y = Math.min(first.y, second.y)
  return {
    x,
    y,
    width: Math.max(first.x, second.x) - x,
    height: Math.max(first.y, second.y) - y,
  }
}

export function constrainSelection(
  selection: DisplaySelection,
  display: CaptureDisplay,
): DisplaySelection {
  if (selection.displayId !== display.id) {
    throw new Error('The selection belongs to a different display.')
  }
  assertRectangle(selection.bounds)

  const intersection = intersect(selection.bounds, display.bounds)
  if (!intersection || intersection.width <= 0 || intersection.height <= 0) {
    throw new Error('The selection does not intersect its display.')
  }

  return { ...selection, bounds: intersection }
}

/** Converts screen DIP coordinates into an outward-rounded crop in captured pixels. */
export function logicalSelectionToPhysicalCrop(
  selection: DisplaySelection,
  display: CaptureDisplay,
  capturedSize: Size = display.physicalSize,
): Rectangle {
  const constrained = constrainSelection(selection, display)
  assertSize(capturedSize)

  const relativeLeft = constrained.bounds.x - display.bounds.x
  const relativeTop = constrained.bounds.y - display.bounds.y
  const scaleX = capturedSize.width / display.bounds.width
  const scaleY = capturedSize.height / display.bounds.height
  const left = clamp(Math.floor(relativeLeft * scaleX), 0, capturedSize.width)
  const top = clamp(Math.floor(relativeTop * scaleY), 0, capturedSize.height)
  const right = clamp(
    Math.ceil((relativeLeft + constrained.bounds.width) * scaleX),
    left,
    capturedSize.width,
  )
  const bottom = clamp(
    Math.ceil((relativeTop + constrained.bounds.height) * scaleY),
    top,
    capturedSize.height,
  )

  return { x: left, y: top, width: right - left, height: bottom - top }
}

function intersect(first: Rectangle, second: Rectangle): Rectangle | null {
  const x = Math.max(first.x, second.x)
  const y = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null
}

function assertRectangle(rectangle: Rectangle): void {
  if (
    !Number.isFinite(rectangle.x) ||
    !Number.isFinite(rectangle.y) ||
    !Number.isFinite(rectangle.width) ||
    !Number.isFinite(rectangle.height) ||
    rectangle.width <= 0 ||
    rectangle.height <= 0
  ) {
    throw new Error('Selection bounds must be finite and non-empty.')
  }
}

function assertSize(size: Size): void {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error('Captured size must be finite and non-empty.')
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
