import type { BrowserWindowConstructorOptions, MessagePortMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  displayAtPoint,
  type CaptureDisplay,
  type CaptureTarget,
  type Point,
} from './selection-models'
import { logger, serializeErrorForLog } from '../shared/logger'

const log = logger.child('selection')

// Bundled into dist-electron alongside selection-preload.mjs.
const selectionPreloadPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'selection-preload.mjs',
)

export type SelectionSurfaceResult = CaptureTarget | 'cancelled'

interface SelectionPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  start(): void
  close(): void
}

interface SelectionWindow {
  readonly webContents: {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }) => void): void
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: unknown) => void,
    ): void
    postMessage(channel: string, message: null, ports: MessagePortMain[]): void
  }
  setAlwaysOnTop(flag: boolean, level: 'screen-saver', relativeLevel: number): void
  setVisibleOnAllWorkspaces(flag: boolean, options: { visibleOnFullScreen: boolean }): void
  setContentProtection(flag: boolean): void
  on(event: 'closed', listener: () => void): void
  loadURL(url: string): Promise<unknown>
  showInactive(): void
  focus(): void
  blur(): void
  hide(): void
  destroy(): void
  isDestroyed(): boolean
}

export interface SelectionSurfaceDependencies {
  createWindow(options: BrowserWindowConstructorOptions): SelectionWindow
  createChannel(): { port1: SelectionPort; port2: MessagePortMain }
  getCursorPoint(): Point
}

interface PooledWindow {
  display: CaptureDisplay
  signature: string
  window: SelectionWindow
  loaded: boolean
  retired: boolean
  loading: Promise<void>
}

interface ActiveSelection {
  signal: AbortSignal
  resolve(result: SelectionSurfaceResult): void
  cancel(): void
  pending: Set<string>
  ready: Set<string>
  ports: Set<SelectionPort>
  focusDisplayId: string | null
  settled: boolean
}

/**
 * Keeps the small, sandboxed selector renderers warm between captures. The
 * expensive renderer load happens once per display geometry; every selection
 * still receives a fresh MessagePort and is isolated by an ActiveSelection.
 */
export class SelectionSurfaceController {
  readonly #windows = new Map<string, PooledWindow>()
  #active: ActiveSelection | null = null

  constructor(private readonly dependencies: SelectionSurfaceDependencies) {}

  select(
    displays: readonly CaptureDisplay[],
    signal: AbortSignal,
  ): Promise<SelectionSurfaceResult> {
    log.info('select requested', {
      displays: displays.length,
      aborted: signal.aborted,
      busy: Boolean(this.#active),
    })
    if (signal.aborted || displays.length === 0 || this.#active) {
      return Promise.resolve('cancelled')
    }

    return new Promise<SelectionSurfaceResult>((resolve) => {
      const cursorDisplay = displayAtPoint(displays, this.dependencies.getCursorPoint())
      const active: ActiveSelection = {
        signal,
        resolve,
        cancel: () => this.#finish(active, 'cancelled'),
        pending: new Set(displays.map((display) => display.id)),
        ready: new Set(),
        ports: new Set(),
        focusDisplayId: cursorDisplay?.id ?? displays[0]?.id ?? null,
        settled: false,
      }
      this.#active = active
      signal.addEventListener('abort', active.cancel, { once: true })
      this.#reconcile(displays, active)
    })
  }

  dispose(): void {
    if (this.#active) {
      this.#finish(this.#active, 'cancelled')
    }
    for (const entry of this.#windows.values()) {
      entry.retired = true
      if (!entry.window.isDestroyed()) entry.window.destroy()
    }
    this.#windows.clear()
  }

  #reconcile(displays: readonly CaptureDisplay[], active: ActiveSelection): void {
    const desired = new Map(displays.map((display) => [display.id, display]))
    for (const [displayId, entry] of this.#windows) {
      const display = desired.get(displayId)
      if (!display || entry.signature !== displaySignature(display)) {
        this.#retire(entry)
      }
    }

    for (const display of displays) {
      if (this.#active !== active) return
      let entry = this.#windows.get(display.id)
      if (!entry) {
        try {
          entry = this.#createWindow(display)
        } catch (error) {
          // The remaining displays can still host the selector; this one is
          // dropped from the round rather than failing the whole selection.
          log.warn('selector window creation failed', {
            displayId: display.id,
            pending: active.pending.size,
            error: serializeErrorForLog(error),
          })
          active.pending.delete(display.id)
          this.#finishIfUnavailable(active)
          continue
        }
      }
      if (this.#active !== active) {
        if (!entry.loaded) this.#retire(entry)
        return
      }
      void entry.loading.then(
        () => this.#activate(entry, active),
        () => this.#windowFailed(entry, active),
      )
    }
    this.#finishIfUnavailable(active)
  }

  #createWindow(display: CaptureDisplay): PooledWindow {
    const window = this.dependencies.createWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000001',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // A macOS non-activating panel can be focused (to receive the drag and the
      // Esc key) without activating the Electron app. Without this, focusing the
      // selector makes Codexly the active app and macOS never returns focus to
      // the app the user was working in once the selector closes.
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: selectionPreloadPath,
      },
    })
    const entry: PooledWindow = {
      display,
      signature: displaySignature(display),
      window,
      loaded: false,
      retired: false,
      loading: Promise.resolve(),
    }
    this.#windows.set(display.id, entry)

    window.setAlwaysOnTop(true, 'screen-saver', 2)
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setContentProtection(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => {
      if (entry.retired || this.#windows.get(display.id) !== entry) return
      const active = this.#active
      if (active) {
        active.pending.delete(display.id)
        active.ready.delete(display.id)
      }
      this.#retire(entry)
      if (active) this.#finishIfUnavailable(active)
    })
    window.on('closed', () => {
      if (this.#windows.get(display.id) === entry) {
        this.#windows.delete(display.id)
      }
      const active = this.#active
      if (!entry.retired && active) {
        active.pending.delete(display.id)
        active.ready.delete(display.id)
        this.#finishIfUnavailable(active)
      }
    })
    entry.loading = window.loadURL(selectionDocument(display)).then(() => {
      if (entry.retired || window.isDestroyed()) {
        throw new Error('Selection window closed while loading.')
      }
      entry.loaded = true
    })
    // Attach a rejection handler immediately; per-selection activation also
    // observes the rejection, but this prevents an unhandled rejection if an
    // abort retires the entry before activation is attached.
    void entry.loading.catch(() => undefined)
    return entry
  }

  #activate(entry: PooledWindow, active: ActiveSelection): void {
    if (
      this.#active !== active ||
      active.signal.aborted ||
      entry.retired ||
      entry.window.isDestroyed() ||
      this.#windows.get(entry.display.id) !== entry
    ) {
      return
    }
    try {
      const { port1, port2 } = this.dependencies.createChannel()
      active.ports.add(port1)
      port1.on('message', ({ data }) => {
        if (
          this.#active !== active ||
          entry.retired ||
          this.#windows.get(entry.display.id) !== entry ||
          !isSelectionMessage(data)
        ) return
        if (data.displayId !== entry.display.id) return
        if (data.type === 'cancelled') {
          this.#finish(active, 'cancelled')
          return
        }
        this.#finish(active, {
          kind: 'selection',
          selection: {
            displayId: entry.display.id,
            coordinateSpace: 'screen-dip',
            bounds: data.bounds,
          },
        })
      })
      port1.start()
      entry.window.webContents.postMessage('codexly-selection-port', null, [port2])
      active.pending.delete(entry.display.id)
      active.ready.add(entry.display.id)
      entry.window.showInactive()
      const takesFocus = entry.display.id === active.focusDisplayId
      log.debug('activated selector window', {
        displayId: entry.display.id,
        takesFocus,
        ready: active.ready.size,
        pending: active.pending.size,
      })
      if (takesFocus) entry.window.focus()
    } catch (error) {
      // This selector window is unusable (channel, postMessage or show failed);
      // retire it and let the other displays finish the selection.
      log.warn('selector window activation failed', {
        displayId: entry.display.id,
        ready: active.ready.size,
        pending: active.pending.size,
        error: serializeErrorForLog(error),
      })
      active.pending.delete(entry.display.id)
      active.ready.delete(entry.display.id)
      this.#retire(entry)
      this.#finishIfUnavailable(active)
    }
  }

  #windowFailed(entry: PooledWindow, active: ActiveSelection): void {
    active.pending.delete(entry.display.id)
    active.ready.delete(entry.display.id)
    this.#retire(entry)
    this.#finishIfUnavailable(active)
  }

  #retire(entry: PooledWindow): void {
    entry.retired = true
    if (this.#windows.get(entry.display.id) === entry) {
      this.#windows.delete(entry.display.id)
    }
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }

  #finishIfUnavailable(active: ActiveSelection): void {
    if (active.pending.size === 0 && active.ready.size === 0) {
      this.#finish(active, 'cancelled')
    }
  }

  #finish(active: ActiveSelection, result: SelectionSurfaceResult): void {
    if (active.settled || this.#active !== active) return
    log.info('select finished', {
      result: result === 'cancelled' ? 'cancelled' : 'selection',
      windows: this.#windows.size,
    })
    active.settled = true
    this.#active = null
    active.signal.removeEventListener('abort', active.cancel)
    for (const port of active.ports) port.close()
    active.ports.clear()
    // Blur before hiding so a macOS panel yields key status; because the
    // selector is a non-activating panel it never activated the Electron app,
    // so key focus falls back to the app the user was working in.
    for (const entry of this.#windows.values()) {
      if (!entry.window.isDestroyed()) {
        entry.window.blur()
        entry.window.hide()
      }
    }
    active.resolve(result)
  }
}

/**
 * Builds a selector-window pool. Construction is deliberately a factory rather
 * than a module-level singleton: importing this module must not reach into the
 * Electron runtime, so the composition root owns the instance and its teardown.
 */
export function createSelectionSurface(
  dependencies: SelectionSurfaceDependencies,
): SelectionSurfaceController {
  return new SelectionSurfaceController(dependencies)
}

type SelectionMessage =
  | { type: 'cancelled'; displayId: string }
  | {
      type: 'selected'
      displayId: string
      bounds: { x: number; y: number; width: number; height: number }
    }

function isSelectionMessage(value: unknown): value is SelectionMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (typeof message.displayId !== 'string') return false
  if (message.type === 'cancelled') return true
  if (message.type !== 'selected' || !message.bounds || typeof message.bounds !== 'object') return false
  const bounds = message.bounds as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number')
}

function displaySignature(display: CaptureDisplay): string {
  const { x, y, width, height } = display.bounds
  return `${x}:${y}:${width}:${height}`
}

function selectionDocument(display: CaptureDisplay): string {
  const config = JSON.stringify({ id: display.id, x: display.bounds.x, y: display.bounds.y })
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:rgba(3,7,18,.28)}
#hint{position:fixed;left:50%;top:24px;transform:translateX(-50%);padding:8px 12px;border:1px solid rgba(255,255,255,.25);border-radius:8px;background:rgba(0,0,0,.72);color:white;font:12px -apple-system,BlinkMacSystemFont,sans-serif;pointer-events:none}
#selection{position:fixed;display:none;border:2px solid white;background:rgba(255,255,255,.08);box-shadow:0 0 0 99999px rgba(0,0,0,.35);pointer-events:none}
#size{position:absolute;right:0;bottom:-25px;padding:3px 6px;border-radius:4px;background:rgba(0,0,0,.8);color:white;font:10px ui-monospace,monospace;white-space:nowrap}
</style>
</head>
<body>
<div id="hint">Drag to select · Esc to cancel</div>
<div id="selection"><span id="size"></span></div>
<script>
const display=${config};let port=null;let start=null;let pending=null;
const selection=document.getElementById('selection');const size=document.getElementById('size');
const send=value=>{if(port)port.postMessage(value);else pending=value;};
window.addEventListener('message',event=>{if(event.data==='codexly-selection-port'){port?.close();port=event.ports[0];port.start();start=null;selection.style.display='none';document.body.dataset.portReady='true';if(pending){port.postMessage(pending);pending=null;}}});
const rect=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
const render=value=>{selection.style.display='block';selection.style.left=value.x+'px';selection.style.top=value.y+'px';selection.style.width=value.width+'px';selection.style.height=value.height+'px';size.textContent=Math.round(value.width)+' × '+Math.round(value.height);};
window.addEventListener('mousedown',event=>{if(event.button!==0)return;start={x:event.clientX,y:event.clientY};render({x:start.x,y:start.y,width:0,height:0});});
window.addEventListener('mousemove',event=>{if(!start)return;render(rect(start,{x:event.clientX,y:event.clientY}));});
window.addEventListener('mouseup',event=>{if(!start||event.button!==0)return;const value=rect(start,{x:event.clientX,y:event.clientY});start=null;if(value.width<4||value.height<4){send({type:'cancelled',displayId:display.id});return;}send({type:'selected',displayId:display.id,bounds:{x:display.x+value.x,y:display.y+value.y,width:value.width,height:value.height}});});
window.addEventListener('keydown',event=>{if(event.key==='Escape')send({type:'cancelled',displayId:display.id});});
</script>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
