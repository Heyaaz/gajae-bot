import { ipcMain } from 'electron'
import { PRODUCTIVITY_IPC } from '../shared/productivity-ipc.js'
import type { ProductivityService } from './productivity-service.js'
import { IpcSecurity } from './ipc-security.js'

function requiredUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new Error('Invalid URL')
  return value
}

function requiredQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid query')
  return value
}

export function registerProductivityIpcHandlers(service: ProductivityService, security: IpcSecurity): () => void {
  const preview = (_event: Electron.IpcMainInvokeEvent, value: unknown) => service.previewLink(requiredUrl(value))
  const search = (_event: Electron.IpcMainInvokeEvent, value: unknown, limit?: unknown) => {
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) throw new Error('Invalid limit')
    return service.searchTranscripts(requiredQuery(value), limit as number | undefined)
  }
  const rebuild = () => service.rebuildSearch()
  ipcMain.handle(PRODUCTIVITY_IPC.previewLink, security.guarded(preview))
  ipcMain.handle(PRODUCTIVITY_IPC.searchTranscripts, security.guarded(search))
  ipcMain.handle(PRODUCTIVITY_IPC.rebuildSearch, security.guarded(rebuild))
  return () => {
    ipcMain.removeHandler(PRODUCTIVITY_IPC.previewLink)
    ipcMain.removeHandler(PRODUCTIVITY_IPC.searchTranscripts)
    ipcMain.removeHandler(PRODUCTIVITY_IPC.rebuildSearch)
  }
}
