import { app, dialog, ipcMain } from 'electron'
import { open, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentControlPreferences, FileAttachment, ImageAttachment } from '../shared/agent-contract.js'
import { SETTINGS_IPC } from '../shared/settings-ipc.js'
import type { SettingsStore } from './settings-store.js'
import type { AttachmentStore } from './attachment-store.js'
import type { IpcSecurity } from './ipc-security.js'
import { checkGjcUpdate, installGjcUpdate } from './gjc-updater.js'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMAGE_COUNT = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_COUNT = 5
const MAX_FILE_BYTES = 25 * 1024 * 1024
const FILE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.toml': 'application/toml', '.xml': 'application/xml', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.scss': 'text/x-scss',
  '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.py': 'text/x-python', '.rb': 'text/x-ruby',
  '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java-source', '.kt': 'text/x-kotlin', '.kts': 'text/x-kotlin',
  '.swift': 'text/x-swift', '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
  '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript', '.zsh': 'text/x-shellscript', '.fish': 'text/x-shellscript',
  '.sql': 'application/sql', '.graphql': 'application/graphql', '.ini': 'text/plain', '.conf': 'text/plain',
  '.config': 'text/plain', '.properties': 'text/plain',
}

export async function pickerDirectory(candidate: unknown, fallbackDirectory?: string): Promise<string> {
  if (typeof candidate === 'string' && path.isAbsolute(candidate)) {
    try {
      if ((await stat(candidate)).isDirectory()) return path.resolve(candidate)
    } catch {
      // Fall through when a previous workspace or attachment directory vanished.
    }
  }
  const fallback = fallbackDirectory ?? app?.getPath?.('downloads') ?? homedir()
  try {
    if ((await stat(fallback)).isDirectory()) return path.resolve(fallback)
  } catch {
    // Home is the final local fallback.
  }
  return app?.getPath?.('home') ?? homedir()
}

async function imageAttachment(filePath: string, store: AttachmentStore, senderId: number, index = 0): Promise<ImageAttachment> {
  const extension = path.extname(filePath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`${path.basename(filePath)}은(는) 지원하는 이미지 형식이 아닙니다`)
  const handle = await open(filePath, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${path.basename(filePath)}은(는) 파일이 아닙니다`)
    if (before.size > MAX_IMAGE_BYTES) throw new Error(`${path.basename(filePath)}은(는) 10 MiB 제한을 초과합니다`)
    const buffer = Buffer.alloc(before.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`${path.basename(filePath)}이(가) 읽는 동안 변경되었습니다`)
    }
    const mimeType = extension === '.png' ? 'image/png'
      : extension === '.webp' ? 'image/webp'
        : extension === '.gif' ? 'image/gif'
          : 'image/jpeg'
    const metadata = { name: path.basename(filePath), mimeType, size: before.size, mtimeMs: before.mtimeMs }
    const record = await store.issue(senderId, 'image', filePath, metadata)
    return { id: `image-${Date.now()}-${index}`, name: metadata.name, mimeType, token: record.token, data: buffer.toString('base64') }
  } finally {
    await handle.close()
  }
}

export function fileMimeType(filePath: string): string | undefined {
  return FILE_MIME_TYPES[path.extname(filePath).toLowerCase()]
}

export async function fileAttachment(filePath: string, store: AttachmentStore, senderId: number): Promise<FileAttachment> {
  const resolved = path.resolve(filePath)
  if (/[\0\r\n]/u.test(resolved)) throw new Error(`${path.basename(filePath)}의 경로에 지원하지 않는 문자가 있습니다`)
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`${path.basename(filePath)} is not a file`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path.basename(filePath)} exceeds the 25 MiB limit`)
  const name = path.basename(resolved)
  const mimeType = fileMimeType(resolved) ?? 'application/octet-stream'
  const record = await store.issue(senderId, 'file', resolved, { name, mimeType, size: info.size, mtimeMs: info.mtimeMs })
  return { id: `file-${randomUUID()}`, name, mimeType, size: info.size, token: record.token }
}

export function registerSettingsIpcHandlers(
  store: SettingsStore,
  attachments: AttachmentStore,
  security: IpcSecurity,
  onPreferencesSaved?: (preferences: AgentControlPreferences) => Promise<boolean>,
  onGjcUpdated?: () => Promise<void>,
): () => void {
  ipcMain.handle(SETTINGS_IPC.getPreferences, security.guarded(() => store.get()))
  ipcMain.handle(SETTINGS_IPC.chooseWorkspace, security.guarded(async (event, currentPath: unknown) => {
    const current = typeof currentPath === 'string' && path.isAbsolute(currentPath) ? path.dirname(currentPath) : undefined
    const defaultPath = await pickerDirectory(current)
    const selected = await dialog.showOpenDialog(security.owner(event), {
      title: 'Choose Gajae project',
      defaultPath,
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    return selected.canceled ? null : selected.filePaths[0] ?? null
  }))
  ipcMain.handle(SETTINGS_IPC.prepareImages, security.guarded(async (event, records: unknown) => {
    if (!Array.isArray(records) || records.some((value) => !value || typeof value !== 'object' || typeof (value as { path?: unknown }).path !== 'string' || !path.isAbsolute((value as { path: string }).path))) {
      throw new Error('이미지 파일이 올바르지 않습니다')
    }
    if (records.length > MAX_IMAGE_COUNT) throw new Error(`이미지는 메시지당 최대 ${MAX_IMAGE_COUNT}장까지 첨부할 수 있습니다`)
    const prepared: ImageAttachment[] = []
    try {
      for (let index = 0; index < records.length; index += 1) {
        const filePath = (records[index] as { path: string }).path
        try { prepared.push(await imageAttachment(filePath, attachments, event.sender.id, index)) }
        catch (error) {
          console.error(`Image attachment preparation failed for ${path.basename(filePath)}`, error)
          throw new Error(`${path.basename(filePath)}: 이미지를 준비하지 못했습니다`)
        }
      }
      return prepared
    } catch (error) {
      const tokens = prepared.flatMap((attachment) => attachment.token ? [attachment.token] : [])
      if (tokens.length > 0) attachments.revoke(event.sender.id, tokens)
      throw error
    }
  }))
  ipcMain.handle(SETTINGS_IPC.prepareFiles, security.guarded(async (event, records: unknown) => {
    if (!Array.isArray(records) || records.some((value) => !value || typeof value !== 'object' || typeof (value as { path?: unknown }).path !== 'string' || !path.isAbsolute((value as { path: string }).path))) {
      throw new Error('파일이 올바르지 않습니다')
    }
    if (records.length > MAX_FILE_COUNT) throw new Error(`파일은 메시지당 최대 ${MAX_FILE_COUNT}개까지 첨부할 수 있습니다`)
    const prepared: FileAttachment[] = []
    try {
      for (const value of records) {
        const filePath = (value as { path: string }).path
        try { prepared.push(await fileAttachment(filePath, attachments, event.sender.id)) }
        catch (error) {
          console.error(`File attachment preparation failed for ${path.basename(filePath)}`, error)
          throw new Error(`${path.basename(filePath)}: 파일을 준비하지 못했습니다`)
        }
      }
      return prepared
    } catch (error) {
      if (prepared.length > 0)
        attachments.revoke(event.sender.id, prepared.map((attachment) => attachment.token))
      throw error
    }
  }))
  ipcMain.handle(SETTINGS_IPC.discardAttachments, security.guarded((event, tokens: unknown) => {
    if (
      !Array.isArray(tokens) ||
      tokens.length === 0 ||
      tokens.length > MAX_IMAGE_COUNT + MAX_FILE_COUNT ||
      tokens.some((token) => typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token))
    ) throw new Error('첨부 권한이 올바르지 않습니다')
    attachments.revoke(event.sender.id, [...new Set(tokens)])
  }))
  ipcMain.handle(SETTINGS_IPC.setWorkspaceLabel, security.guarded((_event, label: unknown) => store.setWorkspaceLabel(label)))
  // A reading preference, not a runtime change: it is saved on its own so toggling a
  // reasoning card never raises the whole-settings confirmation a savePreferences
  // call would.
  ipcMain.handle(SETTINGS_IPC.setThoughtsExpanded, security.guarded((_event, expanded: unknown) => {
    if (typeof expanded !== 'boolean') throw new Error('Thought card expansion must be a boolean')
    return store.setThoughtsExpanded(expanded)
  }))
  ipcMain.handle(SETTINGS_IPC.savePreferences, security.guarded(async (event, preferences: AgentControlPreferences) => {
    const validated = store.validate(preferences)
    await security.authorizeDestructive(event, {
      message: 'Apply runtime settings?',
      detail: `${validated.workspace} · ${validated.modelPreset} · ${validated.permissionHandling}`,
    })
    const saved = store.save(validated)
    const runtimeReconnected = await onPreferencesSaved?.(saved) ?? false
    return { preferences: saved, runtimeReconnected }
  }))
  const executable = () => store.get().gjcExecutable || process.env.GJC_BIN || 'gjc'
  ipcMain.handle(SETTINGS_IPC.checkGjcUpdate, security.guarded(() => checkGjcUpdate(executable())))
  ipcMain.handle(SETTINGS_IPC.installGjcUpdate, security.guarded(async (event) => {
    await security.authorizeDestructive(event, { message: 'Install GJC update?' })
    const status = await installGjcUpdate(executable())
    await onGjcUpdated?.()
    return status
  }))

  return () => {
    for (const channel of Object.values(SETTINGS_IPC)) ipcMain.removeHandler(channel)
  }
}
