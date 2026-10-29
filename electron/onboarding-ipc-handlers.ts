import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ONBOARDING_IPC, type OnboardingEvent } from '../shared/onboarding.js'
import type { IpcSecurity } from './ipc-security.js'
import type { OnboardingService } from './onboarding-service.js'

/** One line GJC's login can read as an answer: a newline would answer the next question too. */
export function signInAnswer(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\0\r\n]/u.test(value))
    throw new Error('Sign-in answer is invalid')
  return value.trim()
}

function emitter(event: IpcMainInvokeEvent): (payload: OnboardingEvent) => void {
  return (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(ONBOARDING_IPC.event, payload)
  }
}

export function registerOnboardingIpcHandlers(onboarding: OnboardingService, security: IpcSecurity): () => void {
  ipcMain.handle(ONBOARDING_IPC.pendingStep, security.guarded(() => onboarding.pendingStep()))
  ipcMain.handle(ONBOARDING_IPC.installGjc, security.guarded((event) => onboarding.installGjc(emitter(event))))
  ipcMain.handle(ONBOARDING_IPC.signIn, security.guarded((event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('Sign-in provider is invalid')
    return onboarding.startSignIn(providerId, emitter(event))
  }))
  ipcMain.handle(ONBOARDING_IPC.answer, security.guarded((_event, text: unknown) => onboarding.answer(signInAnswer(text))))
  ipcMain.handle(ONBOARDING_IPC.cancelSignIn, security.guarded(() => onboarding.cancelSignIn()))
  ipcMain.handle(ONBOARDING_IPC.dismiss, security.guarded(() => onboarding.dismiss()))
  return () => {
    for (const channel of Object.values(ONBOARDING_IPC)) ipcMain.removeHandler(channel)
  }
}
