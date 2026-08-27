import { ipcMain } from 'electron'
import type { McpServerInput } from '../shared/agent-contract.js'
import { DESKTOP_SERVICES_IPC as IPC } from '../shared/desktop-services-ipc.js'
import { ManagementService } from './desktop-services.js'

function requiredString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code === 0 || code === 127
  })) throw new Error(`${label} is invalid`)
  return value.trim()
}

function workspace(value: unknown): string {
  const candidate = requiredString(value, 'Workspace', 4096)
  if (!candidate.startsWith('/')) throw new Error('Workspace must be absolute')
  return candidate
}

function mcpInput(value: unknown): McpServerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP server input is required')
  const candidate = value as Partial<McpServerInput>
  if (candidate.scope !== 'user' && candidate.scope !== 'project') throw new Error('MCP scope is invalid')
  if (candidate.type !== 'stdio' && candidate.type !== 'http' && candidate.type !== 'sse') throw new Error('MCP transport is invalid')
  if (!Array.isArray(candidate.args) || candidate.args.length > 64 || candidate.args.some((argument) => typeof argument !== 'string' || argument.length > 8192 || argument.includes('\0'))) {
    throw new Error('MCP arguments are invalid')
  }
  return {
    name: requiredString(candidate.name, 'MCP server name', 128),
    scope: candidate.scope,
    type: candidate.type,
    args: candidate.args,
    ...(candidate.command === undefined ? {} : { command: requiredString(candidate.command, 'MCP command', 4096) }),
    ...(candidate.url === undefined ? {} : { url: requiredString(candidate.url, 'MCP URL', 4096) }),
    ...(candidate.cwd === undefined ? {} : { cwd: workspace(candidate.cwd) }),
  }
}

export function registerDesktopServicesIpcHandlers(management: ManagementService): () => void {
  const managementChannels = Object.values(IPC.management)

  ipcMain.handle(IPC.management.getSnapshot, (_event, value: unknown) => management.getSnapshot(workspace(value)))
  ipcMain.handle(IPC.management.addMcpServer, (_event, value: unknown, input: unknown) => management.addMcpServer(workspace(value), mcpInput(input)))
  ipcMain.handle(IPC.management.removeMcpServer, (_event, value: unknown, scope: unknown, name: unknown) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('MCP scope is invalid')
    return management.removeMcpServer(workspace(value), scope, requiredString(name, 'MCP server name', 128))
  })
  ipcMain.handle(IPC.management.setPluginEnabled, (_event, value: unknown, name: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Plugin enabled state is invalid')
    return management.setPluginEnabled(workspace(value), requiredString(name, 'Plugin name', 128), enabled)
  })
  ipcMain.handle(IPC.management.installPlugin, (_event, value: unknown, target: unknown, scope: unknown) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('Plugin scope is invalid')
    return management.installPlugin(workspace(value), requiredString(target, 'Plugin target', 256), scope)
  })
  ipcMain.handle(IPC.management.uninstallPlugin, (_event, value: unknown, name: unknown) =>
    management.uninstallPlugin(workspace(value), requiredString(name, 'Plugin name', 128)))

  return () => {
    for (const channel of managementChannels) ipcMain.removeHandler(channel)
  }
}
