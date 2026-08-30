import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { AUTOMATION_IPC } from '../shared/automation-ipc.js'
import { AutomationService, validateAutomationInput } from './automation-service.js'
import { IpcSecurity } from './ipc-security.js'

export function registerAutomationIpcHandlers(service: AutomationService, security: IpcSecurity): () => void {
  ipcMain.handle(AUTOMATION_IPC.list, security.guarded(() => service.list()))
  ipcMain.handle(AUTOMATION_IPC.create, security.guarded(async (event: IpcMainInvokeEvent, input: unknown) => {
    const validated = validateAutomationInput(input)
    await security.authorizeDestructive(event, { message: 'Create automation?', detail: validated.name })
    return service.create(validated)
  }))
  ipcMain.handle(AUTOMATION_IPC.updateEnabled, security.guarded(async (event: IpcMainInvokeEvent, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('invalid automation update')
    const value = input as Record<string, unknown>
    await security.authorizeDestructive(event, { message: 'Change automation status?', detail: 'This will change whether the automation is enabled.' })
    return service.updateEnabled(value.id as string, value.enabled as boolean)
  }))
  ipcMain.handle(AUTOMATION_IPC.delete, security.guarded(async (event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid automation id')
    await security.authorizeDestructive(event, { message: 'Delete automation?', detail: 'This will permanently remove the automation.' })
    return service.delete(id)
  }))
  ipcMain.handle(AUTOMATION_IPC.listRuns, security.guarded((_event, id: unknown) => {
    if (id !== undefined && typeof id !== 'string') throw new Error('invalid automation id')
    return service.listRuns(id as string | undefined)
  }))
  ipcMain.handle(AUTOMATION_IPC.runNow, security.guarded(async (event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid automation id')
    await security.authorizeDestructive(event, { message: 'Run automation now?', detail: 'This will immediately run the automation.' })
    return service.runNow(id)
  }))
  return () => { for (const channel of Object.values(AUTOMATION_IPC)) ipcMain.removeHandler(channel) }
}
