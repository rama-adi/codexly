import { vi, type Mock } from 'vitest'

/**
 * State a preload test observes: what the bridge exposed to the renderer, the
 * channel listeners it attached, and the invoke stub the test drives. It is
 * created inside `vi.hoisted` by the test (the mock factory is hoisted above
 * imports, so the object itself cannot come from this module).
 */
export interface FakeRendererBridge {
  handlers: Map<string, (...args: unknown[]) => void>
  exposed: unknown
  invoke: Mock
}

/**
 * The single `vi.mock('electron', ...)` factory for the whole main-process test
 * suite. Only modules that touch Electron at import time need it — after the
 * composition-root refactor that is just `preload.ts`, which runs inside the
 * renderer and has no adapter seam of its own.
 */
export function createFakeElectron(bridge: FakeRendererBridge) {
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, value: unknown) => {
        bridge.exposed = value
      }),
    },
    ipcRenderer: {
      invoke: bridge.invoke,
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        bridge.handlers.set(channel, listener)
      }),
      send: vi.fn(),
      removeListener: vi.fn(),
    },
  }
}

/** Returns the bridge to its pre-import state between cases. */
export function resetFakeRendererBridge(bridge: FakeRendererBridge): void {
  bridge.handlers.clear()
  bridge.exposed = undefined
  bridge.invoke.mockReset()
}
