import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('codexly', {
  v1: Object.freeze({}),
})
