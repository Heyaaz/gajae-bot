import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { AUTOMATION_IPC } from '../shared/automation-ipc.js'
import { AutomationService, validateAutomationInput } from './automation-service.js'
import { IpcSecurity } from './ipc-security.js'

const automationName = async (service: AutomationService, id: unknown): Promise<string | undefined> =>
  (await service.list()).find((automation) => automation.id === id)?.name

export function registerAutomationIpcHandlers(service: AutomationService, security: IpcSecurity): () => void {
  ipcMain.handle(AUTOMATION_IPC.list, security.guarded(() => service.list()))
  ipcMain.handle(AUTOMATION_IPC.create, security.guarded(async (event: IpcMainInvokeEvent, input: unknown) => {
    const validated = validateAutomationInput(input)
    await security.authorizeDestructive(event, { message: '자동화를 만들까요?', detail: validated.name, confirmLabel: '만들기' })
    return service.create(validated)
  }))
  ipcMain.handle(AUTOMATION_IPC.updateEnabled, security.guarded(async (event: IpcMainInvokeEvent, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('invalid automation update')
    const value = input as Record<string, unknown>
    await security.authorizeDestructive(event, {
      message: value.enabled ? '자동화를 켤까요?' : '자동화를 끌까요?',
      detail: await automationName(service, value.id),
      confirmLabel: value.enabled ? '켜기' : '끄기',
    })
    return service.updateEnabled(value.id as string, value.enabled as boolean)
  }))
  ipcMain.handle(AUTOMATION_IPC.delete, security.guarded(async (event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid automation id')
    await security.authorizeDestructive(event, {
      message: '자동화를 삭제할까요? 되돌릴 수 없습니다.',
      detail: await automationName(service, id),
      confirmLabel: '삭제',
      danger: true,
    })
    return service.delete(id)
  }))
  ipcMain.handle(AUTOMATION_IPC.listRuns, security.guarded((_event, id: unknown) => {
    if (id !== undefined && typeof id !== 'string') throw new Error('invalid automation id')
    return service.listRuns(id as string | undefined)
  }))
  ipcMain.handle(AUTOMATION_IPC.runNow, security.guarded(async (event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid automation id')
    await security.authorizeDestructive(event, {
      message: '자동화를 지금 실행할까요?',
      detail: await automationName(service, id),
      confirmLabel: '실행',
    })
    return service.runNow(id)
  }))
  return () => { for (const channel of Object.values(AUTOMATION_IPC)) ipcMain.removeHandler(channel) }
}
