import { execFile, spawn } from 'node:child_process'
import { access, open, readFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { runtimeEnvironment } from './runtime-path.js'
import type {
  ManagementSnapshot,
  McpServerInput,
  McpServerSummary,
  PluginSummary,
  SkillSummary,
  UsageStats,
} from '../shared/agent-contract.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_STATS_OUTPUT = 16 * 1024 * 1024
const MAX_ARGUMENTS = 64

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown, maximum = 4096): string {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Parses a GJC JSON document that may be preceded by a synchronization preamble.
 *
 * The whole document is parsed within `limit`; slicing the tail would discard the
 * beginning of a valid payload and make the caller fail on a document it accepted.
 * The limit is the caller's output contract, so it is checked here as well as when
 * the bytes are produced.
 */
export function parseJsonOutput(text: string, limit = MAX_OUTPUT): unknown {
  if (Buffer.byteLength(text) > limit)
    throw new Error(`GJC output exceeds the ${Math.floor(limit / (1024 * 1024))} MiB limit`)
  const candidates = [...text.matchAll(/[[{]/gu)].map((match) => match.index)
  for (const index of candidates) {
    try {
      return JSON.parse(text.slice(index)) as unknown
    } catch {
      // GJC may print a bounded synchronization preamble before its JSON payload.
    }
  }
  throw new Error('GJC did not return valid JSON')
}

function validateWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) {
    throw new Error('Workspace must be an absolute path')
  }
  return path.resolve(workspace)
}

function validateName(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(name)) throw new Error('Invalid name')
  return name
}

function validatePinnedPluginTarget(target: string): string {
  const value = typeof target === 'string' ? target.trim() : ''
  const version = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?'
  const unscoped = new RegExp(`^[a-z0-9][a-z0-9._-]*@${version}$`, 'u')
  const scoped = new RegExp(`^@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*@${version}$`, 'u')
  if (!unscoped.test(value) && !scoped.test(value)) {
    throw new Error('Plugin target must be an exact npm package version, for example package@1.2.3')
  }
  return value
}

type CommandRunner = typeof execFileAsync

export class ManagementService {
  constructor(private executable = 'gjc', private readonly runner: CommandRunner = execFileAsync) {}

  setExecutable(executable: string): void {
    this.executable = executable || 'gjc'
  }

  private async resolveExecutable(): Promise<string> {
    const candidates = [
      this.executable,
      process.env.GJC_BIN,
      path.join(homedir(), '.bun/bin/gjc'),
      path.join(homedir(), '.local/bin/gjc'),
      '/opt/homebrew/bin/gjc',
      '/usr/local/bin/gjc',
    ].filter((candidate): candidate is string => Boolean(candidate))
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next explicit installation path.
      }
    }
    return 'gjc'
  }

  private async runJson(args: string[], workspace: string): Promise<unknown> {
    const cwd = validateWorkspace(workspace)
    if (args.length > MAX_ARGUMENTS || args.some((argument) => typeof argument !== 'string' || argument.length > 8192 || argument.includes('\0'))) {
      throw new Error('GJC command arguments are invalid')
    }
    const result = await this.runner(await this.resolveExecutable(), args, {
      cwd,
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT,
      env: runtimeEnvironment(),
    })
    return parseJsonOutput(result.stdout)
  }

  private async runStatsJson(workspace: string): Promise<unknown> {
    if (this.runner !== execFileAsync) return this.runJson(['stats', '--json'], workspace)
    const cwd = validateWorkspace(workspace)
    const outputPath = path.join(tmpdir(), `gajae-stats-${process.pid}-${randomUUID()}.json`)
    const output = await open(outputPath, 'wx', 0o600)
    try {
      const executable = await this.resolveExecutable()
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ['stats', '--json'], {
          cwd,
          env: runtimeEnvironment(),
          stdio: ['ignore', output.fd, 'pipe'],
        })
        let stderr = ''
        const stderrStream = child.stderr
        if (!stderrStream) {
          child.kill('SIGKILL')
          reject(new Error('GJC stats stderr pipe is unavailable'))
          return
        }
        stderrStream.setEncoding('utf8')
        stderrStream.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096) })
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`GJC stats failed (${signal ?? code ?? 'unknown'}): ${stderr.trim()}`))
        })
      })
      // Check the produced size before reading it, so an oversized document is never
      // loaded or partially parsed.
      const info = await output.stat()
      if (info.size > MAX_STATS_OUTPUT)
        throw new Error('GJC stats output exceeds the 16 MiB limit')
      const text = await readFile(outputPath, 'utf8')
      return parseJsonOutput(text, MAX_STATS_OUTPUT)
    } finally {
      await output.close()
      await unlink(outputPath).catch(() => undefined)
    }
  }

  async getSnapshot(workspace: string): Promise<ManagementSnapshot> {
    const [userMcpRaw, projectMcpRaw, skillsRaw, pluginsRaw, statsRaw] = await Promise.all([
      this.runJson(['mcp', 'list', '--json'], workspace),
      this.runJson(['mcp', 'list', '--project', '--json'], workspace),
      this.runJson(['skills', 'discover', '--json'], workspace),
      this.runJson(['plugin', 'list', '--json'], workspace),
      this.runStatsJson(workspace),
    ])
    const mcpServers: McpServerSummary[] = ([['user', userMcpRaw], ['project', projectMcpRaw]] as const).flatMap(([scope, raw]) => {
      const mcpRecord = record(raw)
      return (Array.isArray(mcpRecord?.servers) ? mcpRecord.servers : []).flatMap((value) => {
        const server = record(value)
        if (!server || !stringValue(server.name)) return []
        const type = server.type === 'http' || server.type === 'sse' ? server.type : 'stdio'
        return [{
          name: stringValue(server.name, 128),
          scope,
          type,
          enabled: server.enabled !== false,
          status: stringValue(server.status) || undefined,
          command: stringValue(server.command) || undefined,
          url: stringValue(server.url) || undefined,
        }]
      })
    })

    const skillsRecord = record(skillsRaw)
    const skills: SkillSummary[] = (Array.isArray(skillsRecord?.candidates) ? skillsRecord.candidates : []).flatMap((value) => {
      const skill = record(value)
      if (!skill || !stringValue(skill.name)) return []
      return [{
        name: stringValue(skill.name, 128),
        description: stringValue(skill.description, 2048),
        source: stringValue(skill.source, 64),
        path: stringValue(skill.path, 4096) || undefined,
      }]
    })

    const pluginsRecord = record(pluginsRaw)
    const plugins: PluginSummary[] = (['npm', 'marketplace', 'gjc'] as const).flatMap((source) => {
      const values = pluginsRecord?.[source]
      if (!Array.isArray(values)) return []
      return values.flatMap((value) => {
        const plugin = record(value)
        if (!plugin || !stringValue(plugin.name)) return []
        return [{
          name: stringValue(plugin.name, 128),
          version: stringValue(plugin.version, 128) || undefined,
          source,
          enabled: plugin.enabled !== false,
          enabledFeatures: Array.isArray(plugin.enabledFeatures)
            ? plugin.enabledFeatures.filter((entry): entry is string => typeof entry === 'string').slice(0, 100)
            : [],
        }]
      })
    })

    const statsRecord = record(statsRaw)
    const overall = record(statsRecord?.overall)
    const usage: UsageStats = {
      requests: numberValue(overall?.totalRequests),
      inputTokens: numberValue(overall?.totalInputTokens),
      outputTokens: numberValue(overall?.totalOutputTokens),
      cacheRate: numberValue(overall?.cacheRate),
      cost: numberValue(overall?.totalCost),
      models: (Array.isArray(statsRecord?.byModel) ? statsRecord.byModel : []).flatMap((value) => {
        const model = record(value)
        if (!model || !stringValue(model.model)) return []
        return [{
          model: stringValue(model.model, 256),
          provider: stringValue(model.provider, 128),
          requests: numberValue(model.totalRequests),
          inputTokens: numberValue(model.totalInputTokens),
          outputTokens: numberValue(model.totalOutputTokens),
          cacheRate: numberValue(model.cacheRate),
          cost: numberValue(model.totalCost),
        }]
      }),
    }
    return { mcpServers, skills, plugins, usage, refreshedAt: new Date().toISOString() }
  }

  private async mutate(workspace: string, args: string[]): Promise<ManagementSnapshot> {
    await this.runJson(args, workspace)
    return this.getSnapshot(workspace)
  }

  async addMcpServer(workspace: string, input: McpServerInput): Promise<ManagementSnapshot> {
    const name = validateName(input.name)
    if (input.args.length > MAX_ARGUMENTS || input.args.some((argument) => argument.length > 8192 || argument.includes('\0'))) {
      throw new Error('MCP arguments are invalid')
    }
    const scope = input.scope === 'project' ? ['--project'] : []
    if (input.type === 'stdio') {
      if (!input.command || !path.isAbsolute(input.command)) throw new Error('MCP command must be an absolute executable path')
      return await this.mutate(workspace, ['mcp', 'add', name, '--json', ...scope, '--type', 'stdio', '--command', input.command, ...input.args.flatMap((argument) => ['--arg', argument]), ...(input.cwd ? ['--cwd', validateWorkspace(input.cwd)] : [])])
    }
    if (!input.url) throw new Error('MCP URL is required')
    const url = new URL(input.url)
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('Remote MCP URLs must use HTTPS')
    }
    return await this.mutate(workspace, ['mcp', 'add', name, '--json', ...scope, '--type', input.type, '--url', url.toString()])
  }

  removeMcpServer(workspace: string, scope: 'user' | 'project', name: string): Promise<ManagementSnapshot> {
    return this.mutate(workspace, ['mcp', 'remove', validateName(name), '--json', ...(scope === 'project' ? ['--project'] : [])])
  }

  setPluginEnabled(workspace: string, name: string, enabled: boolean): Promise<ManagementSnapshot> {
    return this.mutate(workspace, ['plugin', enabled ? 'enable' : 'disable', validateName(name), '--json'])
  }

  installPlugin(workspace: string, target: string, scope: 'user' | 'project'): Promise<ManagementSnapshot> {
    return this.mutate(workspace, ['plugin', 'install', validatePinnedPluginTarget(target), '--scope', scope === 'project' ? 'project' : 'user', '--json'])
  }

  uninstallPlugin(workspace: string, name: string): Promise<ManagementSnapshot> {
    return this.mutate(workspace, ['plugin', 'uninstall', validateName(name), '--json'])
  }
}
