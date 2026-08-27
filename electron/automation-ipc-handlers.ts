import { ipcMain } from 'electron'
import { AUTOMATION_IPC } from '../shared/automation-ipc.js'
import { AutomationService } from './automation-service.js'

export function registerAutomationIpcHandlers(service: AutomationService): () => void {
  ipcMain.handle(AUTOMATION_IPC.list, () => service.list())
  ipcMain.handle(AUTOMATION_IPC.create, (_event, input: unknown) => service.create(input))
  ipcMain.handle(AUTOMATION_IPC.updateEnabled, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('invalid automation update')
    const value = input as Record<string, unknown>
    return service.updateEnabled(value.id as string, value.enabled as boolean)
  })
  ipcMain.handle(AUTOMATION_IPC.delete, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid automation id')
    return service.delete(id)
  })
  ipcMain.handle(AUTOMATION_IPC.listRuns, (_event, id: unknown) => {
    if (id !== undefined && typeof id !== 'string') throw new Error('invalid automation id')
    return service.listRuns(id as string | undefined)
  })
  ipcMain.handle(AUTOMATION_IPC.runNow, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid automation id')
    return service.runNow(id)
  })
  return () => { for (const channel of Object.values(AUTOMATION_IPC)) ipcMain.removeHandler(channel) }
}
