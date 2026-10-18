import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { AutomationService, automationPlist, launchCalendarInterval, validateAutomationInput } from './automation-service.js'

describe('automation service contracts', () => {
  it('validates absolute workspace and bounded schedule', () => {
    expect(() => validateAutomationInput({ name: 'x', prompt: 'p', workspace: 'relative', schedule: { kind: 'daily', time: '09:00' }, enabled: true, worktree: false })).toThrow()
    expect(validateAutomationInput({ name: 'x', prompt: 'p', workspace: '/tmp/project', schedule: { kind: 'weekly', time: '09:00', weekday: 2 }, enabled: true, worktree: false }).schedule.weekday).toBe(2)
  })
  it('maps schedule and never embeds prompt in plist', () => {
    expect(launchCalendarInterval({ kind: 'weekly', time: '03:04', weekday: 6 })).toEqual({ Weekday: 6, Hour: 3, Minute: 4 })
    expect(launchCalendarInterval({ kind: 'weekdays', time: '03:04' })).toEqual([1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 3, Minute: 4 })))
    const plist = automationPlist('com.gajae.x', '/Applications/Electron', '/tmp/worker.js', '/tmp/config.json', { kind: 'daily', time: '03:04' })
    expect(plist).toContain('ELECTRON_RUN_AS_NODE')
    expect(plist).not.toContain('prompt')
  })
  it('persists lifecycle, prevents overlap, and constructs bounded GJC arguments', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-'))
    const launchCalls: string[][] = []
    const spawnCalls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = []
    const spawnProcess = ((executable: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ executable, args, options })
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean }
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
      setTimeout(() => child.emit('close', 0), 20)
      return child
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'darwin', launchctl: (args) => { launchCalls.push(args) }, spawnProcess })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'weekdays', time: '09:30' }, enabled: true, modelProfile: 'codex-medium', thinking: 'high', worktree: true })
    expect((await service.list()).map((item) => item.id)).toEqual([created.id])
    expect(launchCalls.some((call) => call[0] === 'load')).toBe(true)
    const concurrent = await Promise.all([service.runNow(created.id), service.runNow(created.id)])
    expect(concurrent.map((run) => run.status).sort()).toEqual(['completed', 'skipped'])
    expect(concurrent.find((run) => run.status === 'completed')).toMatchObject({ exitCode: 0 })
    expect(spawnCalls[0]).toMatchObject({ executable: '/usr/local/bin/gjc', args: ['--print', '--mpreset', 'codex-medium', '--thinking', 'high', '--worktree', 'Review changes'], options: { cwd: '/tmp', shell: false } })
    await service.updateEnabled(created.id, false)
    expect((await service.list())[0]?.enabled).toBe(false)
    await service.delete(created.id)
    expect(await service.list()).toEqual([])
  })

  it('keeps the lock until a timed-out child confirms it exited', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-timeout-'))
    const signals: string[] = []
    let spawned = 0
    const spawnProcess = (() => {
      spawned += 1
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number; kill(signal: string): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 4321
      // The first child ignores both signals and never emits close. The second
      // completes normally once the retry is allowed to start.
      child.kill = (signal: string) => {
        signals.push(signal)
        if (spawned > 1) setTimeout(() => child.emit('close', 0), 5)
        return true
      }
      return child
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none', spawnProcess, timeoutMs: 10, killGraceMs: 20 })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: true, worktree: false })

    const timedOut = await service.runNow(created.id)
    expect(timedOut.status).toBe('failed')
    expect(timedOut.error).toContain('exceeded 10ms')
    expect(timedOut.error).toContain('did not confirm termination')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])

    // The first process never proved it exited, so the workspace lock stays and a
    // second run must not start while the old process may still be alive.
    const blocked = await service.runNow(created.id)
    expect(blocked.status).toBe('skipped')
    expect(spawned).toBe(1)
  })

  it('releases the lock when a timed-out child exits during the grace period', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-grace-'))
    let spawned = 0
    const spawnProcess = (() => {
      spawned += 1
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number; kill(): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 4321
      child.kill = () => {
        setTimeout(() => child.emit('close', null), 5)
        return true
      }
      return child
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none', spawnProcess, timeoutMs: 10, killGraceMs: 50 })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: true, worktree: false })

    const timedOut = await service.runNow(created.id)
    expect(timedOut.status).toBe('failed')
    expect(timedOut.error).toContain('was terminated')

    const retried = await service.runNow(created.id)
    expect(retried.status).toBe('failed')
    expect(spawned).toBe(2)
  })

  it('serializes concurrent definition changes instead of losing a save', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-concurrent-'))
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none' })
    const created = await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        service.create({ name: `Review ${index}`, prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: index % 2 === 0, worktree: false }),
      ),
    )
    const persisted = await service.list()
    expect(persisted).toHaveLength(10)
    expect(new Set(persisted.map((item) => item.id))).toEqual(new Set(created.map((item) => item.id)))
    expect(new Set(persisted.map((item) => item.name)).size).toBe(10)

    // A disabled update racing a delete must not resurrect the deleted record.
    const [keep] = created
    await Promise.all([
      service.updateEnabled(keep.id, false),
      service.delete(created[1].id),
      service.delete(created[2].id),
    ])
    const after = await service.list()
    expect(after).toHaveLength(8)
    expect(after.find((item) => item.id === keep.id)?.enabled).toBe(false)
  })

  it('releases the lock when the starting history write fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-history-'))
    let spawned = 0
    const spawnProcess = (() => {
      spawned += 1
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number; kill(): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 1234
      child.kill = () => true
      setTimeout(() => child.emit('close', 0), 5)
      return child
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none', spawnProcess })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: true, worktree: false })

    // A file where the runs directory belongs makes the initial history write fail.
    await writeFile(path.join(directory, 'runs'), 'not a directory')
    await expect(service.runNow(created.id)).rejects.toThrow()

    // The failed start left no lock, so the next attempt can run once the history
    // destination is usable again.
    await rm(path.join(directory, 'runs'), { force: true })
    const retried = await service.runNow(created.id)
    expect(retried.status).toBe('completed')
    expect(spawned).toBe(1)
  })

  it('recovers a lock whose owner process is dead', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-stale-'))
    let spawned = 0
    const spawnProcess = (() => {
      spawned += 1
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number; kill(): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 1234
      child.kill = () => true
      setTimeout(() => child.emit('close', 0), 5)
      return child
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none', spawnProcess })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: true, worktree: false })

    const lock = path.join(directory, `.run-${created.id}.lock`)
    await mkdir(lock)
    // 999999 is beyond the usable pid range, so no process can own it.
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, token: 'dead', startedAt: new Date().toISOString(), automationId: created.id }))
    const recovered = await service.runNow(created.id)
    expect(recovered.status).toBe('completed')
    expect(spawned).toBe(1)
  })

  it('does not remove a lock held by a live process', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-live-'))
    let spawned = 0
    const spawnProcess = (() => {
      spawned += 1
      throw new Error('must not spawn while another run is live')
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none', spawnProcess })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: true, worktree: false })

    const lock = path.join(directory, `.run-${created.id}.lock`)
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live', startedAt: new Date().toISOString(), automationId: created.id }))
    const blocked = await service.runNow(created.id)
    expect(blocked.status).toBe('skipped')
    expect(spawned).toBe(0)
    expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toContain('live')
  })

  it('records a child process error event instead of crashing the worker', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-error-'))
    let spawned = 0
    const spawnProcess = (() => {
      spawned += 1
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid?: number; kill(): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      if (spawned === 1) {
        // A missing executable reports asynchronously; close is not guaranteed.
        child.pid = undefined
        setTimeout(() => child.emit('error', Object.assign(new Error('spawn gjc ENOENT'), { code: 'ENOENT' })), 10)
      } else {
        child.pid = 1234
        setTimeout(() => child.emit('close', 0), 10)
      }
      return child
    }) as never
    const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'none', spawnProcess })
    const created = await service.create({ name: 'Review', prompt: 'Review changes', workspace: '/tmp', schedule: { kind: 'daily', time: '09:30' }, enabled: true, worktree: false })

    const failed = await service.runNow(created.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('ENOENT')

    // The completion path released the lock: the next attempt really runs.
    const retried = await service.runNow(created.id)
    expect(retried.status).toBe('completed')
    expect(spawned).toBe(2)
  })

  it('schedules the automations around a record it cannot read', async () => {
    // `defs()` only guards against the file failing to parse. A record written by an
    // older schema -- a daily schedule with no time -- threw out of the loop, so every
    // automation after it was left unregistered with launchd. The caller only logs, so
    // the user saw no error, just scheduled work that silently stopped running.
    const directory = await mkdtemp(path.join(tmpdir(), 'gajae-automation-skip-'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const record = (id: string, schedule: unknown) => ({ id, name: id, prompt: 'p', workspace: '/tmp', enabled: true, thinking: 'medium', worktree: false, schedule, createdAt: new Date().toISOString() })
      await writeFile(path.join(directory, 'automations.json'), JSON.stringify([
        record('first', { kind: 'daily', time: '09:00' }),
        record('broken', { kind: 'daily' }),
        record('last', { kind: 'daily', time: '10:00' }),
      ]))
      const loaded: string[] = []
      const service = new AutomationService({ directory, launchAgentsDirectory: path.join(directory, 'agents'), electronPath: '/Applications/Gajae', workerPath: '/app/automation-worker.js', gjcExecutable: '/usr/local/bin/gjc', platform: 'darwin', launchctl: (args) => { if (args[0] === 'load' && args[1]) loaded.push(path.basename(args[1])) } })

      await service.initialize()

      // The record before the bad one was already reached; the one after it is what
      // used to be lost.
      expect(loaded).toContain('com.gajae.automation.first.plist')
      expect(loaded).toContain('com.gajae.automation.last.plist')
      expect(loaded).not.toContain('com.gajae.automation.broken.plist')
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
