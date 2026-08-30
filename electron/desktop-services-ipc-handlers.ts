import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { McpServerInput } from '../shared/agent-contract.js'
import { DESKTOP_SERVICES_IPC as IPC } from '../shared/desktop-services-ipc.js'
import { ManagementService } from './desktop-services.js'
import { IpcSecurity } from './ipc-security.js'

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

export function registerDesktopServicesIpcHandlers(management: ManagementService, security: IpcSecurity): () => void {
  const managementChannels = Object.values(IPC.management)

  ipcMain.handle(IPC.management.getSnapshot, security.guarded((_event, value: unknown) => management.getSnapshot(workspace(value))))
  ipcMain.handle(IPC.management.addMcpServer, security.guarded(async (event: IpcMainInvokeEvent, value: unknown, input: unknown) => {
    const target = workspace(value)
    const server = mcpInput(input)
    await security.authorizeDestructive(event, { message: 'Add MCP server?', detail: `This will add the MCP server "${server.name}".` })
    return management.addMcpServer(target, server)
  }))
  ipcMain.handle(IPC.management.removeMcpServer, security.guarded(async (event: IpcMainInvokeEvent, value: unknown, scope: unknown, name: unknown) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('MCP scope is invalid')
    const target = workspace(value)
    const serverName = requiredString(name, 'MCP server name', 128)
    await security.authorizeDestructive(event, { message: 'Remove MCP server?', detail: `This will remove the MCP server "${serverName}".` })
    return management.removeMcpServer(target, scope, serverName)
  }))
  ipcMain.handle(IPC.management.setPluginEnabled, security.guarded(async (event: IpcMainInvokeEvent, value: unknown, name: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Plugin enabled state is invalid')
    const workspacePath = workspace(value)
    const pluginName = requiredString(name, 'Plugin name', 128)
    await security.authorizeDestructive(event, { message: 'Change plugin status?', detail: `This will ${enabled ? 'enable' : 'disable'} plugin "${pluginName}".` })
    return management.setPluginEnabled(workspacePath, pluginName, enabled)
  }))
  ipcMain.handle(IPC.management.installPlugin, security.guarded(async (event: IpcMainInvokeEvent, value: unknown, target: unknown, scope: unknown) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('Plugin scope is invalid')
    const workspacePath = workspace(value)
    const pluginTarget = requiredString(target, 'Plugin target', 256)
    await security.authorizeDestructive(event, { message: 'Install plugin?', detail: `This will install plugin "${pluginTarget}".` })
    return management.installPlugin(workspacePath, pluginTarget, scope)
  }))
  ipcMain.handle(IPC.management.uninstallPlugin, security.guarded(async (event: IpcMainInvokeEvent, value: unknown, name: unknown) => {
    const workspacePath = workspace(value)
    const pluginName = requiredString(name, 'Plugin name', 128)
    await security.authorizeDestructive(event, { message: 'Uninstall plugin?', detail: `This will uninstall plugin "${pluginName}".` })
    return management.uninstallPlugin(workspacePath, pluginName)
  }))

  return () => {
    for (const channel of managementChannels) ipcMain.removeHandler(channel)
  }
}
