import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagementService, parseJsonOutput } from './desktop-services.js'

describe('ManagementService', () => {
  it('normalizes redacted GJC management JSON across every source', async () => {
    const runner = vi.fn().mockImplementation((_executable: string, args: string[]) => {
      const command = args.slice(0, 2).join(' ')
      if (command === 'mcp list') return Promise.resolve({ stdout: JSON.stringify({ servers: args.includes('--project') ? [{ name: 'project-docs', type: 'http', url: 'https://example.test', enabled: true }] : [{ name: 'user-tools', type: 'stdio', command: '/usr/bin/env', enabled: true }] }), stderr: '' })
      if (command === 'skills discover') return Promise.resolve({ stdout: JSON.stringify({ candidates: [{ name: 'review', description: 'Review code', source: 'project', path: '/tmp/project/.gjc/skills/review/SKILL.md' }] }), stderr: '' })
      if (command === 'plugin list') return Promise.resolve({ stdout: JSON.stringify({ npm: [{ name: 'plugin-a', version: '1.0.0', enabled: true }], marketplace: [], gjc: [] }), stderr: '' })
      if (args[0] === 'stats') return Promise.resolve({ stdout: `Syncing session files...\n${JSON.stringify({ overall: { totalRequests: 10, totalInputTokens: 100, totalOutputTokens: 20, cacheRate: 0.5, totalCost: 1.25 }, byModel: [{ model: 'model-a', provider: 'provider', totalRequests: 10, totalInputTokens: 100, totalOutputTokens: 20, cacheRate: 0.5, totalCost: 1.25 }] })}`, stderr: '' })
      return Promise.resolve({ stdout: JSON.stringify({ ok: true }), stderr: '' })
    })
    const service = new ManagementService('/usr/bin/gjc', runner as never)

    await expect(service.getSnapshot('/tmp')).resolves.toMatchObject({
      mcpServers: [
        { name: 'user-tools', scope: 'user', command: '/usr/bin/env' },
        { name: 'project-docs', scope: 'project', url: 'https://example.test' },
      ],
      skills: [{ name: 'review', source: 'project' }],
      plugins: [{ name: 'plugin-a', enabled: true }],
      usage: { requests: 10, inputTokens: 100, outputTokens: 20, cacheRate: 0.5, cost: 1.25 },
    })
  })

  it('keeps the whole stats document within the 16 MiB contract', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-stats-size-'))
    try {
      const executable = path.join(directory, 'gjc')
      // Real executable path: runStatsJson streams stats to a file and accepts up to
      // 16 MiB, while the other commands stay on the 4 MiB JSON path.
      await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'stats') {
  process.stdout.write(JSON.stringify({ overall: { totalRequests: 7 }, byModel: [], pad: 'x'.repeat(5 * 1024 * 1024) }))
} else if (args[0] === 'mcp') {
  process.stdout.write('{"servers":[]}')
} else if (args[0] === 'skills') {
  process.stdout.write('{"candidates":[]}')
} else if (args[0] === 'plugin') {
  process.stdout.write('{"npm":[],"marketplace":[],"gjc":[]}')
} else {
  process.stdout.write('{"ok":true}')
}
`, { mode: 0o755 })
      await chmod(executable, 0o755)
      const service = new ManagementService(executable)
      await expect(service.getSnapshot('/tmp')).resolves.toMatchObject({ usage: { requests: 7 } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('checks the stats document size before parsing and keeps the 4 MiB boundary', () => {
    const document = JSON.stringify({ overall: { totalRequests: 1 }, byModel: [] })
    const exact = 'x'.repeat(4 * 1024 * 1024 - document.length) + document
    expect(Buffer.byteLength(exact)).toBe(4 * 1024 * 1024)
    expect(parseJsonOutput(exact)).toMatchObject({ overall: { totalRequests: 1 } })
    expect(() => parseJsonOutput('x' + exact)).toThrow('4 MiB limit')
    expect(() => parseJsonOutput(exact, 16 * 1024 * 1024)).not.toThrow()
  })

  it('uses project-scoped MCP arguments and rejects secret-prone endpoints', async () => {
    const calls: string[][] = []
    const runner = vi.fn().mockImplementation((_executable: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'mcp') return Promise.resolve({ stdout: '{"servers":[]}', stderr: '' })
      if (args[0] === 'skills') return Promise.resolve({ stdout: '{"candidates":[]}', stderr: '' })
      if (args[0] === 'plugin') return Promise.resolve({ stdout: '{"npm":[],"marketplace":[],"gjc":[]}', stderr: '' })
      if (args[0] === 'stats') return Promise.resolve({ stdout: '{"overall":{},"byModel":[]}', stderr: '' })
      return Promise.resolve({ stdout: '{"ok":true}', stderr: '' })
    })
    const service = new ManagementService('/usr/bin/gjc', runner as never)

    await service.addMcpServer('/tmp', { name: 'docs', scope: 'project', type: 'stdio', command: '/usr/bin/env', args: ['node', 'server.js'] })
    expect(calls).toContainEqual(['mcp', 'add', 'docs', '--json', '--project', '--type', 'stdio', '--command', '/usr/bin/env', '--arg', 'node', '--arg', 'server.js'])
    await expect(service.addMcpServer('/tmp', { name: 'bad', scope: 'user', type: 'stdio', command: 'npx', args: [] })).rejects.toThrow('absolute executable')
    await expect(service.addMcpServer('/tmp', { name: 'bad', scope: 'user', type: 'http', url: 'http://example.test', args: [] })).rejects.toThrow('HTTPS')
  })

  it('installs only exact npm plugin versions without force flags', async () => {
    const calls: string[][] = []
    const runner = vi.fn().mockImplementation((_executable: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'mcp') return Promise.resolve({ stdout: '{"servers":[]}', stderr: '' })
      if (args[0] === 'skills') return Promise.resolve({ stdout: '{"candidates":[]}', stderr: '' })
      if (args[0] === 'plugin' && args[1] === 'list') return Promise.resolve({ stdout: '{"npm":[],"marketplace":[],"gjc":[]}', stderr: '' })
      if (args[0] === 'stats') return Promise.resolve({ stdout: '{"overall":{},"byModel":[]}', stderr: '' })
      return Promise.resolve({ stdout: '{"ok":true}', stderr: '' })
    })
    const service = new ManagementService('/usr/bin/gjc', runner as never)

    await service.installPlugin('/tmp', '@scope/plugin@1.2.3', 'project')
    expect(calls).toContainEqual(['plugin', 'install', '@scope/plugin@1.2.3', '--scope', 'project', '--json'])
    await expect(Promise.resolve().then(() => service.installPlugin('/tmp', 'plugin@latest', 'user'))).rejects.toThrow('exact npm package version')
  })
})
