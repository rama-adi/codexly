import { BrowserWindow, MessageChannelMain, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { displayAtPoint, type CaptureDisplay, type CaptureTarget } from './selection-models'

// Bundled into dist-electron alongside selection-preload.mjs.
const selectionPreloadPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'selection-preload.mjs',
)

export type SelectionSurfaceResult = CaptureTarget | 'cancelled'

export async function selectCaptureRegion(
  displays: readonly CaptureDisplay[],
  signal: AbortSignal,
): Promise<SelectionSurfaceResult> {
  if (signal.aborted) return 'cancelled'

  return new Promise<SelectionSurfaceResult>((resolve) => {
    const windows = new Map<string, BrowserWindow>()
    let settled = false

    const finish = (result: SelectionSurfaceResult) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      for (const window of windows.values()) {
        if (!window.isDestroyed()) window.destroy()
      }
      windows.clear()
      resolve(result)
    }
    const cancel = () => finish('cancelled')
    signal.addEventListener('abort', cancel, { once: true })

    for (const display of displays) {
      const window = new BrowserWindow({
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
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: selectionPreloadPath,
        },
      })
      windows.set(display.id, window)
      window.setAlwaysOnTop(true, 'screen-saver', 2)
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      window.setContentProtection(true)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.on('closed', () => {
        windows.delete(display.id)
        if (!settled && windows.size === 0) finish('cancelled')
      })

      void window.loadURL(selectionDocument(display)).then(() => {
        if (settled || window.isDestroyed()) return
        const { port1, port2 } = new MessageChannelMain()
        port1.on('message', ({ data }) => {
          if (!isSelectionMessage(data) || data.displayId !== display.id) return
          if (data.type === 'cancelled') {
            finish('cancelled')
            return
          }
          finish({
            kind: 'selection',
            selection: {
              displayId: display.id,
              coordinateSpace: 'screen-dip',
              bounds: data.bounds,
            },
          })
        })
        port1.start()
        window.webContents.postMessage('codexly-selection-port', null, [port2])
        window.showInactive()
      })
    }

    const cursorDisplay = displayAtPoint(displays, screen.getCursorScreenPoint())
    const focusWindow = cursorDisplay ? windows.get(cursorDisplay.id) : windows.values().next().value
    focusWindow?.once('ready-to-show', () => focusWindow.focus())
  })
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
const display=${config};let port=null;let start=null;
const selection=document.getElementById('selection');const size=document.getElementById('size');
window.addEventListener('message',event=>{if(event.data==='codexly-selection-port'){port=event.ports[0];port.start();document.body.dataset.portReady='true';}});
const rect=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
const render=value=>{selection.style.display='block';selection.style.left=value.x+'px';selection.style.top=value.y+'px';selection.style.width=value.width+'px';selection.style.height=value.height+'px';size.textContent=Math.round(value.width)+' × '+Math.round(value.height);};
window.addEventListener('mousedown',event=>{if(event.button!==0)return;start={x:event.clientX,y:event.clientY};render({x:start.x,y:start.y,width:0,height:0});});
window.addEventListener('mousemove',event=>{if(!start)return;render(rect(start,{x:event.clientX,y:event.clientY}));});
window.addEventListener('mouseup',event=>{if(!start||event.button!==0)return;const value=rect(start,{x:event.clientX,y:event.clientY});start=null;if(value.width<4||value.height<4){port?.postMessage({type:'cancelled',displayId:display.id});return;}port?.postMessage({type:'selected',displayId:display.id,bounds:{x:display.x+value.x,y:display.y+value.y,width:value.width,height:value.height}});});
window.addEventListener('keydown',event=>{if(event.key==='Escape')port?.postMessage({type:'cancelled',displayId:display.id});});
</script>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
