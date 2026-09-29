import { contextBridge, ipcRenderer } from 'electron'

const bridge = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, payload),
  on: (channel: string, cb: (data: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: unknown): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('dy', bridge)
export type DyBridge = typeof bridge
