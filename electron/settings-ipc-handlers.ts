import { app, dialog, ipcMain } from 'electron'
import { open, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentControlPreferences, FileAttachment, ImageAttachment } from '../shared/agent-contract.js'
import { SETTINGS_IPC } from '../shared/settings-ipc.js'
import type { SettingsStore } from './settings-store.js'
import { checkGjcUpdate, installGjcUpdate } from './gjc-updater.js'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMAGE_COUNT = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_COUNT = 5
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

async function imageAttachment(filePath: string, index = 0): Promise<ImageAttachment> {
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
    return { id: `image-${Date.now()}-${index}`, name: path.basename(filePath), mimeType, path: path.resolve(filePath), data: buffer.toString('base64') }
  } finally {
    await handle.close()
  }
}

export function fileMimeType(filePath: string): string | undefined {
  return FILE_MIME_TYPES[path.extname(filePath).toLowerCase()]
}

export async function fileAttachment(filePath: string): Promise<FileAttachment> {
  const resolved = path.resolve(filePath)
  if (/[\0\r\n]/u.test(resolved)) throw new Error(`${path.basename(filePath)}의 경로에 지원하지 않는 문자가 있습니다`)
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`${path.basename(filePath)} is not a file`)
  return { id: `file-${randomUUID()}`, name: path.basename(resolved), mimeType: fileMimeType(resolved) ?? 'application/octet-stream', size: info.size, path: resolved }
}

export function registerSettingsIpcHandlers(
  store: SettingsStore,
  onPreferencesSaved?: (preferences: AgentControlPreferences) => Promise<boolean>,
  onGjcUpdated?: () => Promise<void>,
): () => void {
  ipcMain.handle(SETTINGS_IPC.getPreferences, () => store.get())
  ipcMain.handle(SETTINGS_IPC.chooseWorkspace, async (_event, currentPath: unknown) => {
    const current = typeof currentPath === 'string' && path.isAbsolute(currentPath) ? path.dirname(currentPath) : undefined
    const defaultPath = await pickerDirectory(current)
    app.focus({ steal: true })
    const selected = dialog.showOpenDialogSync({
      title: 'Choose Gajae project',
      defaultPath,
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    return selected?.[0] ?? null
  })
  ipcMain.handle(SETTINGS_IPC.readImages, async (_event, paths: unknown) => {
    if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
      throw new Error('이미지 경로가 올바르지 않습니다')
    }
    if (paths.length > MAX_IMAGE_COUNT) throw new Error(`이미지는 메시지당 최대 ${MAX_IMAGE_COUNT}장까지 첨부할 수 있습니다`)
    return Promise.all(paths.map(imageAttachment))
  })
  ipcMain.handle(SETTINGS_IPC.readFiles, async (_event, paths: unknown) => {
    if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
      throw new Error('파일 경로가 올바르지 않습니다')
    }
    if (paths.length > MAX_FILE_COUNT) throw new Error(`파일은 메시지당 최대 ${MAX_FILE_COUNT}개까지 첨부할 수 있습니다`)
    return Promise.all(paths.map(fileAttachment))
  })
  ipcMain.handle(SETTINGS_IPC.setWorkspaceLabel, (_event, label: unknown) => store.setWorkspaceLabel(label))
  ipcMain.handle(SETTINGS_IPC.savePreferences, async (_event, preferences: AgentControlPreferences) => {
    const saved = store.save(preferences)
    const runtimeReconnected = await onPreferencesSaved?.(saved) ?? false
    return { preferences: saved, runtimeReconnected }
  })
  const executable = () => store.get().gjcExecutable || process.env.GJC_BIN || 'gjc'
  ipcMain.handle(SETTINGS_IPC.checkGjcUpdate, () => checkGjcUpdate(executable()))
  ipcMain.handle(SETTINGS_IPC.installGjcUpdate, async () => {
    const status = await installGjcUpdate(executable())
    await onGjcUpdated?.()
    return status
  })

  return () => {
    for (const channel of Object.values(SETTINGS_IPC)) ipcMain.removeHandler(channel)
  }
}
