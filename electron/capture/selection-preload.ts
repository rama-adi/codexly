import { ipcRenderer } from 'electron'

// The selection surface page is sandboxed with no bridge; its only job is to
// receive the MessagePort the main process sends and hand it to the document.
ipcRenderer.on('codexly-selection-port', (event) => {
  window.postMessage('codexly-selection-port', '*', event.ports)
})
