import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SelectionSurfaceController,
  type SelectionSurfaceDependencies,
} from './selection-surface'
import type { CaptureDisplay } from './selection-models'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakePort {
  listener: ((event: { data: unknown }) => void) | null = null
  started = false
  closed = false

  on(_event: 'message', listener: (event: { data: unknown }) => void) {
    this.listener = listener
  }

  start() {
    this.started = true
  }

  close() {
    this.closed = true
  }

  send(data: unknown) {
    this.listener?.({ data })
  }
}

class FakeWindow {
  readonly loaded = deferred<void>()
  readonly closedListeners: Array<() => void> = []
  readonly postedPorts: unknown[][] = []
  destroyed = false
  visible = false
  focused = false
  blurCount = 0
  hideCount = 0
  loadCount = 0
  readonly webContentsListeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >()
  readonly webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const listeners = this.webContentsListeners.get(event) ?? []
      listeners.push(listener)
      this.webContentsListeners.set(event, listeners)
    }),
    postMessage: vi.fn((_channel: string, _message: null, ports: unknown[]) => {
      this.postedPorts.push(ports)
    }),
  }

  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setContentProtection() {}
  on(_event: 'closed', listener: () => void) {
    this.closedListeners.push(listener)
  }
  loadURL() {
    this.loadCount += 1
    return this.loaded.promise
  }
  showInactive() {
    this.visible = true
  }
  focus() {
    this.focused = true
  }
  blur() {
    this.focused = false
    this.blurCount += 1
  }
  hide() {
    this.visible = false
    this.hideCount += 1
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of this.closedListeners) listener()
  }
  isDestroyed() {
    return this.destroyed
  }
  closeIndependently() {
    this.destroy()
  }
  crashRenderer() {
    for (const listener of this.webContentsListeners.get('render-process-gone') ?? []) {
      listener({}, { reason: 'crashed', exitCode: 9 })
    }
  }
}

const displays: CaptureDisplay[] = [
  {
    id: '1',
    label: 'Primary',
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    workArea: { x: 0, y: 0, width: 1000, height: 760 },
    scaleFactor: 2,
    rotation: 0,
    physicalSize: { width: 2000, height: 1600 },
  },
  {
    id: '2',
    label: 'Secondary',
    bounds: { x: 1000, y: -100, width: 800, height: 600 },
    workArea: { x: 1000, y: -100, width: 800, height: 560 },
    scaleFactor: 1,
    rotation: 0,
    physicalSize: { width: 800, height: 600 },
  },
]

function harness(cursor = { x: 10, y: 10 }) {
  const windows: FakeWindow[] = []
  const ports: FakePort[] = []
  let onCreate: ((window: FakeWindow, index: number) => void) | undefined
  const dependencies: SelectionSurfaceDependencies = {
    createWindow: () => {
      const window = new FakeWindow()
      windows.push(window)
      onCreate?.(window, windows.length - 1)
      return window as never
    },
    createChannel: () => {
      const port = new FakePort()
      ports.push(port)
      return { port1: port, port2: { port } as never }
    },
    getCursorPoint: () => cursor,
  }
  return {
    controller: new SelectionSurfaceController(dependencies),
    windows,
    ports,
    setOnCreate(callback: typeof onCreate) {
      onCreate = callback
    },
  }
}

async function ready(window: FakeWindow) {
  window.loaded.resolve()
  await vi.waitFor(() => expect(window.visible).toBe(true))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('SelectionSurfaceController', () => {
  it('starts every display load concurrently and makes the warm path load-free', async () => {
    const state = harness()
    const first = state.controller.select(displays, new AbortController().signal)
    expect(state.windows).toHaveLength(2)
    expect(state.windows.map((window) => window.loadCount)).toEqual([1, 1])

    await Promise.all(state.windows.map(ready))
    state.ports[0].send({ type: 'cancelled', displayId: '1' })
    await first

    const second = state.controller.select(displays, new AbortController().signal)
    await vi.waitFor(() => expect(state.ports).toHaveLength(4))
    expect(state.windows).toHaveLength(2)
    expect(state.windows.map((window) => window.loadCount)).toEqual([1, 1])
    expect(state.windows.every((window) => window.visible)).toBe(true)
    state.ports[2].send({ type: 'cancelled', displayId: '1' })
    await second
  })

  it('warms the pool so the first selection loads nothing and shows immediately', async () => {
    const state = harness()
    state.controller.warm(displays)
    expect(state.windows).toHaveLength(2)
    expect(state.windows.every((window) => !window.visible)).toBe(true)
    await Promise.all(state.windows.map((window) => window.loaded.resolve()))

    const pending = state.controller.select(displays, new AbortController().signal)
    await vi.waitFor(() => expect(state.windows.every((window) => window.visible)).toBe(true))
    expect(state.windows.map((window) => window.loadCount)).toEqual([1, 1])
    state.ports[0].send({ type: 'cancelled', displayId: '1' })
    await expect(pending).resolves.toBe('cancelled')
  })

  it('re-warms only the displays whose geometry changed and drops failed loads', async () => {
    const state = harness()
    state.controller.warm(displays)
    state.windows[0].loaded.resolve()
    state.windows[1].loaded.reject(new Error('warm load failed'))
    await vi.waitFor(() => expect(state.windows[1].destroyed).toBe(true))

    state.controller.warm([
      displays[0],
      { ...displays[1], bounds: { ...displays[1].bounds, width: 900 } },
    ])
    // The surviving window is reused; only the missing display is recreated.
    expect(state.windows).toHaveLength(3)
    expect(state.windows[0].destroyed).toBe(false)
    expect(state.windows[0].loadCount).toBe(1)
  })

  it('leaves the pool alone while a selection is in flight', async () => {
    const state = harness()
    const pending = state.controller.select([displays[0]], new AbortController().signal)
    await ready(state.windows[0])
    state.controller.warm(displays)
    expect(state.windows).toHaveLength(1)
    state.ports[0].send({ type: 'cancelled', displayId: '1' })
    await expect(pending).resolves.toBe('cancelled')
  })

  it('shows each display as soon as it is ready and focuses the cursor display', async () => {
    const state = harness({ x: 1200, y: 50 })
    const pending = state.controller.select(displays, new AbortController().signal)

    await ready(state.windows[1])
    expect(state.windows[1].focused).toBe(true)
    expect(state.windows[0].visible).toBe(false)
    await ready(state.windows[0])

    state.ports[0].send({
      type: 'selected',
      displayId: '2',
      bounds: { x: 1100, y: 0, width: 100, height: 80 },
    })
    await expect(pending).resolves.toMatchObject({
      kind: 'selection',
      selection: { displayId: '2' },
    })
    expect(state.windows.every((window) => !window.visible)).toBe(true)
    expect(state.windows.every((window) => window.blurCount === 1)).toBe(true)
    expect(state.ports.every((port) => port.closed)).toBe(true)
  })

  it('reuses loaded windows and replaces only displays whose geometry changed', async () => {
    const state = harness()
    const first = state.controller.select(displays, new AbortController().signal)
    await Promise.all(state.windows.map(ready))
    state.ports[0].send({ type: 'cancelled', displayId: '1' })
    await first

    const changed = [
      displays[0],
      { ...displays[1], bounds: { ...displays[1].bounds, width: 900 } },
    ]
    const second = state.controller.select(changed, new AbortController().signal)
    expect(state.windows).toHaveLength(3)
    expect(state.windows[0].destroyed).toBe(false)
    expect(state.windows[1].destroyed).toBe(true)
    await vi.waitFor(() => expect(state.windows[0].visible).toBe(true))
    expect(state.windows[0].closedListeners).toHaveLength(1)
    await ready(state.windows[2])
    state.ports[state.ports.length - 1]?.send({
      type: 'cancelled',
      displayId: '2',
    })
    await second
  })

  it('handles abort before creation and repeated cancellation without leaking windows', async () => {
    const state = harness()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(state.controller.select(displays, alreadyAborted.signal)).resolves.toBe(
      'cancelled',
    )
    expect(state.windows).toHaveLength(0)

    const activeAbort = new AbortController()
    const pending = state.controller.select(displays, activeAbort.signal)
    activeAbort.abort()
    activeAbort.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(state.windows.every((window) => !window.visible)).toBe(true)
  })

  it('survives abort during window creation and ignores later load completion', async () => {
    const state = harness()
    const abort = new AbortController()
    state.setOnCreate((_window, index) => {
      if (index === 0) abort.abort()
    })
    const pending = state.controller.select(displays, abort.signal)
    await expect(pending).resolves.toBe('cancelled')
    state.windows[0].loaded.resolve()
    await Promise.resolve()
    expect(state.windows[0].visible).toBe(false)
    expect(state.windows[0].destroyed).toBe(true)
  })

  it('keeps ready displays usable when another display load rejects or closes', async () => {
    const state = harness()
    const pending = state.controller.select(displays, new AbortController().signal)
    state.windows[0].loaded.reject(new Error('renderer failed'))
    await ready(state.windows[1])
    expect(state.windows[0].destroyed).toBe(true)

    state.ports[0].send({
      type: 'selected',
      displayId: '2',
      bounds: { x: 1010, y: 10, width: 20, height: 20 },
    })
    await expect(pending).resolves.toMatchObject({ kind: 'selection' })

    const next = state.controller.select(displays, new AbortController().signal)
    expect(state.windows).toHaveLength(3)
    await vi.waitFor(() => expect(state.windows[1].visible).toBe(true))
    state.windows[2].closeIndependently()
    expect(state.windows[1].visible).toBe(true)
    state.ports[state.ports.length - 1]?.send({
      type: 'cancelled',
      displayId: '2',
    })
    await expect(next).resolves.toBe('cancelled')
  })

  it('cancels when every display fails to load', async () => {
    const state = harness()
    const pending = state.controller.select(displays, new AbortController().signal)
    state.windows[0].loaded.reject(new Error('one'))
    state.windows[1].loaded.reject(new Error('two'))
    await expect(pending).resolves.toBe('cancelled')
    expect(state.windows.every((window) => window.destroyed)).toBe(true)
  })

  it('retires a pooled renderer that crashes after load and recreates it next time', async () => {
    const state = harness()
    const first = state.controller.select([displays[0]], new AbortController().signal)
    await ready(state.windows[0])
    const stalePort = state.ports[0]

    state.windows[0].crashRenderer()
    await expect(first).resolves.toBe('cancelled')
    expect(state.windows[0].destroyed).toBe(true)

    stalePort.send({
      type: 'selected',
      displayId: '1',
      bounds: { x: 1, y: 1, width: 50, height: 50 },
    })
    const second = state.controller.select([displays[0]], new AbortController().signal)
    expect(state.windows).toHaveLength(2)
    // A delayed duplicate crash notification from the retired renderer must
    // not invalidate the replacement for the same display id.
    state.windows[0].crashRenderer()
    await ready(state.windows[1])
    state.ports[1].send({ type: 'cancelled', displayId: '1' })
    await expect(second).resolves.toBe('cancelled')
  })

  it('keeps other displays selectable when one ready renderer crashes', async () => {
    const state = harness()
    const pending = state.controller.select(displays, new AbortController().signal)
    await Promise.all(state.windows.map(ready))
    state.windows[0].crashRenderer()
    expect(state.windows[1].visible).toBe(true)
    state.ports[1].send({
      type: 'selected',
      displayId: '2',
      bounds: { x: 1010, y: 0, width: 40, height: 40 },
    })
    await expect(pending).resolves.toMatchObject({
      kind: 'selection',
      selection: { displayId: '2' },
    })
  })

  it('rejects a concurrent selector without disturbing the active one', async () => {
    const state = harness()
    const first = state.controller.select(displays, new AbortController().signal)
    await expect(
      state.controller.select(displays, new AbortController().signal),
    ).resolves.toBe('cancelled')
    expect(state.windows).toHaveLength(2)
    await ready(state.windows[0])
    state.ports[0].send({ type: 'cancelled', displayId: '1' })
    await expect(first).resolves.toBe('cancelled')
  })

  it('ignores late port messages after selection or abort during a drag', async () => {
    const state = harness()
    const abort = new AbortController()
    const first = state.controller.select([displays[0]], abort.signal)
    await ready(state.windows[0])
    const stalePort = state.ports[0]
    abort.abort()
    await expect(first).resolves.toBe('cancelled')

    const second = state.controller.select([displays[0]], new AbortController().signal)
    await vi.waitFor(() => expect(state.ports).toHaveLength(2))
    stalePort.send({
      type: 'selected',
      displayId: '1',
      bounds: { x: 1, y: 1, width: 20, height: 20 },
    })
    let settled = false
    void second.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    state.ports[1].send({ type: 'cancelled', displayId: '1' })
    await expect(second).resolves.toBe('cancelled')
  })

  it.each([
    ['abort-before-ready', 'abort', 'resolve'],
    ['close-before-ready', 'close', 'resolve'],
    ['reject-then-abort', 'reject', 'abort'],
  ] as const)(
    'settles deterministic chaos sequence %s',
    async (_name, firstAction, secondAction) => {
      const state = harness()
      const abort = new AbortController()
      const pending = state.controller.select([displays[0]], abort.signal)
      const act = (action: 'abort' | 'close' | 'reject' | 'resolve') => {
        if (action === 'abort') abort.abort()
        if (action === 'close') state.windows[0].closeIndependently()
        if (action === 'reject') state.windows[0].loaded.reject(new Error('chaos'))
        if (action === 'resolve') state.windows[0].loaded.resolve()
      }
      act(firstAction)
      act(secondAction)
      await expect(pending).resolves.toBe('cancelled')
      expect(state.windows[0].visible).toBe(false)
    },
  )

  it('dispose cancels an active selector and destroys every warm window once', async () => {
    const state = harness()
    const pending = state.controller.select(displays, new AbortController().signal)
    state.controller.dispose()
    state.controller.dispose()
    await expect(pending).resolves.toBe('cancelled')
    expect(state.windows.every((window) => window.destroyed)).toBe(true)
  })
})
