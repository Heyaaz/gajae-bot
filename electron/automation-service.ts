import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { homedir } from 'node:os'
import type { Automation, AutomationInput, AutomationRun, AutomationSchedule } from '../shared/automation-ipc.js'

export type LaunchctlRunner = (args: string[]) => Promise<void> | void
export type AutomationServiceOptions = {
  directory: string
  electronPath?: string
  workerPath?: string
  launchAgentsDirectory?: string
  gjcExecutable: string
  launchctl?: LaunchctlRunner
  now?: () => Date
  platform?: string
  spawnProcess?: typeof spawn
  timeoutMs?: number
  /** How long to wait after SIGTERM before SIGKILL, and after SIGKILL before giving up. */
  killGraceMs?: number
}

interface AutomationLockOwner {
  pid: number
  token: string
  startedAt: string
  automationId: string
  childPid?: number
}

function processAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process owned by another user cannot be signalled but still exists.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockOwnerAlive(owner: AutomationLockOwner): boolean {
  return processAlive(owner.pid) || processAlive(owner.childPid)
}

const MAX_NAME = 200, MAX_PROMPT = 20_000, MAX_OUTPUT = 32_000
const validTime = /^([01]\d|2[0-3]):[0-5]\d$/
const validThinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function validateAutomationInput(input: unknown): AutomationInput {
  if (!input || typeof input !== 'object') throw new Error('automation input must be an object')
  const value = input as Record<string, unknown>
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > MAX_NAME) throw new Error('invalid automation name')
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT) throw new Error('invalid automation prompt')
  if (typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace)) throw new Error('workspace must be absolute')
  const schedule = value.schedule as Record<string, unknown> | undefined
  if (!schedule || !['daily', 'weekdays', 'weekly'].includes(String(schedule.kind)) || typeof schedule.time !== 'string' || !validTime.test(schedule.time)) throw new Error('invalid schedule')
  if (schedule.kind === 'weekly' && (!Number.isInteger(schedule.weekday) || Number(schedule.weekday) < 0 || Number(schedule.weekday) > 6)) throw new Error('weekly schedule requires weekday')
  if (schedule.weekday !== undefined && (!Number.isInteger(schedule.weekday) || Number(schedule.weekday) < 0 || Number(schedule.weekday) > 6)) throw new Error('invalid weekday')
  if (typeof value.enabled !== 'boolean' || typeof value.worktree !== 'boolean') throw new Error('enabled and worktree are required')
  if (value.modelProfile !== undefined && (typeof value.modelProfile !== 'string' || value.modelProfile.length > 200)) throw new Error('invalid model profile')
  if (value.thinking !== undefined && (typeof value.thinking !== 'string' || !validThinking.has(value.thinking))) throw new Error('invalid thinking')
  return { name: value.name.trim(), prompt: value.prompt, workspace: value.workspace, schedule: { kind: schedule.kind as AutomationSchedule['kind'], time: schedule.time as AutomationSchedule['time'], ...(schedule.weekday === undefined ? {} : { weekday: schedule.weekday as number }) }, enabled: value.enabled, modelProfile: value.modelProfile as string | undefined, thinking: value.thinking as string | undefined, worktree: value.worktree }
}

export function launchCalendarInterval(schedule: AutomationSchedule): Record<string, number> | Array<Record<string, number>> {
  const [hour, minute] = schedule.time.split(':').map(Number)
  if (schedule.kind === 'weekly') return { Weekday: schedule.weekday!, Hour: hour, Minute: minute }
  if (schedule.kind === 'weekdays') return [1, 2, 3, 4, 5].map((weekday) => ({ Weekday: weekday, Hour: hour, Minute: minute }))
  return { Hour: hour, Minute: minute }
}

function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
export function automationPlist(label: string, electronPath: string, workerPath: string, configPath: string, schedule: AutomationSchedule): string {
  const interval = launchCalendarInterval(schedule)
  const dictionary = (value: Record<string, number>) => `<dict>${Object.entries(value).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>`
  const calendar = Array.isArray(interval) ? `<array>${interval.map(dictionary).join('')}</array>` : dictionary(interval)
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(electronPath)}</string><string>${xml(workerPath)}</string><string>${xml(configPath)}</string></array><key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>StartCalendarInterval</key>${calendar}<key>RunAtLoad</key><false/></dict></plist>`
}

async function atomicJson(file: string, value: unknown): Promise<void> { const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); await rename(tmp, file) }

export class AutomationService {
  private readonly dir: string
  private readonly opts: AutomationServiceOptions
  private readonly launchctl: LaunchctlRunner
  private readonly now: () => Date
  /** Serializes definition read-modify-write and launchd reflection across callers. */
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(options: AutomationServiceOptions) { if (!path.isAbsolute(options.directory) || !path.isAbsolute(options.gjcExecutable)) throw new Error('automation paths must be absolute'); this.opts = options; this.dir = options.directory; this.launchctl = options.launchctl ?? (() => {}); this.now = options.now ?? (() => new Date()) }
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(task, task)
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private defsFile() { return path.join(this.dir, 'automations.json') }
  private runsDirectory() { return path.join(this.dir, 'runs') }
  private plistPath(id: string) { return path.join(this.opts.launchAgentsDirectory ?? this.dir, `com.gajae.automation.${id}.plist`) }
  private async defs(): Promise<Automation[]> { try { return JSON.parse(await readFile(this.defsFile(), 'utf8')) } catch { return [] } }
  private async runs(): Promise<AutomationRun[]> { try { const directory = this.runsDirectory(); const names = await readdir(directory); const records = await Promise.all(names.filter((name) => /^[0-9a-f-]+\.json$/iu.test(name)).map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')) as AutomationRun)); return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 500) } catch { return [] } }
  private async writeRun(run: AutomationRun): Promise<void> { await mkdir(this.runsDirectory(), { recursive: true, mode: 0o700 }); await atomicJson(path.join(this.runsDirectory(), `${run.id}.json`), run) }
  // One unusable record must not silence the rest. `defs()` only guards against the
  // file failing to parse, so a record written by an older schema -- a daily
  // schedule with no time, say -- threw out of the loop and every automation after
  // it was left unregistered with launchd. The caller logs and moves on, so the user
  // saw no error at all, just scheduled work that never ran.
  initialize(): Promise<void> {
    return this.serialize(async () => { await mkdir(this.dir, { recursive: true, mode: 0o700 }); if (this.opts.launchAgentsDirectory) await mkdir(this.opts.launchAgentsDirectory, { recursive: true }); for (const item of await this.defs()) { try { await this.sync(item) } catch (error) { console.error(`Automation ${item?.id ?? '(unknown)'} could not be scheduled and was skipped`, error) } } })
  }
  setGjcExecutable(executable: string): Promise<void> {
    return this.serialize(async () => { if (!path.isAbsolute(executable)) throw new Error('GJC executable must be absolute'); this.opts.gjcExecutable = executable; for (const item of await this.defs()) if (item.enabled) await this.sync(item) })
  }
  async list(): Promise<Automation[]> { return (await this.defs()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) }
  create(input: unknown): Promise<Automation> {
    return this.serialize(async () => { const valid = validateAutomationInput(input); const now = this.now().toISOString(); const item: Automation = { ...valid, id: randomUUID(), createdAt: now, updatedAt: now, nextRunAt: this.next(valid.schedule, this.now()) }; const all = await this.defs(); all.push(item); await mkdir(this.dir, { recursive: true }); await atomicJson(this.defsFile(), all); try { await this.sync(item) } catch (error) { await atomicJson(this.defsFile(), all.filter((candidate) => candidate.id !== item.id)); throw error } return item })
  }
  updateEnabled(id: string, enabled: boolean): Promise<Automation> {
    return this.serialize(async () => { if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('invalid input'); const all = await this.defs(); const item = all.find((a) => a.id === id); if (!item) throw new Error('automation not found'); const previous = { enabled: item.enabled, updatedAt: item.updatedAt, nextRunAt: item.nextRunAt }; item.enabled = enabled; item.updatedAt = this.now().toISOString(); item.nextRunAt = enabled ? this.next(item.schedule, this.now()) : null; await atomicJson(this.defsFile(), all); try { await this.sync(item) } catch (error) { Object.assign(item, previous); await atomicJson(this.defsFile(), all); throw error } return item })
  }
  delete(id: string): Promise<void> {
    return this.serialize(async () => { const all = await this.defs(); const item = all.find((a) => a.id === id); if (!item) return; await this.unload(item); await atomicJson(this.defsFile(), all.filter((a) => a.id !== id)); await rm(this.plistPath(id), { force: true }) })
  }
  async listRuns(automationId?: string): Promise<AutomationRun[]> { const runs = await this.runs(); return automationId ? runs.filter((r) => r.automationId === automationId) : runs }
  async runNow(id: string): Promise<AutomationRun> { const item = (await this.defs()).find((a) => a.id === id); if (!item) throw new Error('automation not found'); return this.execute(item) }
  private async sync(item: Automation): Promise<void> { if (this.opts.platform === 'darwin' || (this.opts.platform === undefined && platform() === 'darwin')) { if (item.enabled) { const config = path.join(this.dir, `config-${item.id}.json`); await atomicJson(config, { automation: item, directory: this.dir, gjcExecutable: this.opts.gjcExecutable }); await mkdir(path.dirname(this.plistPath(item.id)), { recursive: true }); try { await this.launchctl(['unload', this.plistPath(item.id)]) } catch { /* A new schedule has nothing to unload. */ } await writeFile(this.plistPath(item.id), automationPlist(`com.gajae.automation.${item.id}`, this.opts.electronPath ?? process.execPath, this.opts.workerPath ?? '', config, item.schedule)); await this.launchctl(['load', this.plistPath(item.id)]) } else await this.unload(item) } }
  private async unload(item: Automation): Promise<void> { if (this.opts.platform === 'darwin' || (this.opts.platform === undefined && platform() === 'darwin')) { await this.launchctl(['unload', this.plistPath(item.id)]); await rm(this.plistPath(item.id), { force: true }) } }
  private next(schedule: AutomationSchedule, from: Date): string { const d = new Date(from); const [h, m] = schedule.time.split(':').map(Number); d.setSeconds(0, 0); d.setHours(h, m); if (schedule.kind === 'weekly') { let delta = (schedule.weekday! - d.getDay() + 7) % 7; if (!delta && d <= from) delta = 7; d.setDate(d.getDate() + delta) } else if (schedule.kind === 'weekdays') { while (d <= from || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1) } else if (d <= from) d.setDate(d.getDate() + 1); return d.toISOString() }
  /**
   * Claims the per-automation run lock.
   *
   * The lock names its owner so a lock left by a dead worker can be recovered,
   * and one held by a live worker or its GJC child is never removed.
   */
  private async acquireLock(
    lock: string,
    automationId: string,
  ): Promise<AutomationLockOwner | undefined> {
    const owner: AutomationLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      startedAt: this.now().toISOString(),
      automationId,
    }
    if (await this.createLock(lock, owner)) return owner

    const inspected = await this.readLockOwner(lock)
    // An unreadable owner is not proof that nothing is running; leave it alone.
    if (!inspected || lockOwnerAlive(inspected)) return undefined

    // Move the exact stale directory aside before deleting it. A concurrent
    // recovery can then replace the lock only once, and a directory created after
    // inspection is detected by its token and put back.
    const tombstone = `${lock}.stale-${randomUUID()}`
    try {
      await rename(lock, tombstone)
    } catch {
      return undefined
    }
    const moved = await this.readLockOwner(tombstone)
    if (!moved || moved.token !== inspected.token || lockOwnerAlive(moved)) {
      await rename(tombstone, lock).catch(() => undefined)
      return undefined
    }
    await rm(tombstone, { recursive: true, force: true })
    return (await this.createLock(lock, owner)) ? owner : undefined
  }

  private async createLock(
    lock: string,
    owner: AutomationLockOwner,
  ): Promise<boolean> {
    try {
      await mkdir(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    try {
      await this.writeLockOwner(lock, owner)
    } catch (error) {
      await rm(lock, { recursive: true, force: true })
      throw error
    }
    return true
  }

  private async writeLockOwner(
    lock: string,
    owner: AutomationLockOwner,
  ): Promise<void> {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner), {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  private async recordLockChild(
    lock: string,
    owner: AutomationLockOwner,
    childPid: number | undefined,
  ): Promise<void> {
    if (childPid === undefined) return
    await this.writeLockOwner(lock, { ...owner, childPid })
  }

  private async readLockOwner(
    lock: string,
  ): Promise<AutomationLockOwner | undefined> {
    try {
      const value = JSON.parse(
        await readFile(path.join(lock, 'owner.json'), 'utf8'),
      ) as Partial<AutomationLockOwner>
      return Number.isInteger(value.pid) && typeof value.token === 'string'
        ? (value as AutomationLockOwner)
        : undefined
    } catch {
      return undefined
    }
  }

  private async execute(item: Automation): Promise<AutomationRun> {
    await mkdir(this.dir, { recursive: true })
    const lock = path.join(this.dir, `.run-${item.id}.lock`)
    const owner = await this.acquireLock(lock, item.id)
    if (!owner) {
      const skipped = {
        id: randomUUID(),
        automationId: item.id,
        status: 'skipped' as const,
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        exitCode: null,
        output: '',
        error: 'run already in progress',
      }
      await this.writeRun(skipped)
      return skipped
    }
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: item.id,
      status: 'running',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: '',
    }
    try {
      await this.writeRun(run)
    } catch (error) {
      // Starting history is part of claiming the run. A run that was never
      // recorded must not leave its lock behind.
      await rm(lock, { recursive: true, force: true })
      throw error
    }
    let releaseLock = true
    try {
      const args = ['--print']
      if (item.modelProfile) args.push('--mpreset', item.modelProfile)
      if (item.thinking) args.push('--thinking', item.thinking)
      if (item.worktree) args.push('--worktree')
      args.push(item.prompt)
      const runtimePath = [
        path.dirname(this.opts.gjcExecutable),
        path.join(homedir(), '.bun/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ]
        .filter((entry, index, values) => values.indexOf(entry) === index)
        .join(path.delimiter)
      const child = (this.opts.spawnProcess ?? spawn)(this.opts.gjcExecutable, args, {
        cwd: item.workspace,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: runtimePath },
      })
      // Record the process a later worker must see as alive when deciding whether
      // this lock is stale. The worker can exit while its GJC child keeps running.
      await this.recordLockChild(lock, owner, child.pid).catch(() => undefined)
      let out = ''
      let err = ''
      child.stdout?.on('data', (b) => {
        out = (out + b.toString()).slice(-MAX_OUTPUT)
      })
      child.stderr?.on('data', (b) => {
        err = (err + b.toString()).slice(-MAX_OUTPUT)
      })
      const completion = await this.completeChild(
        child,
        this.opts.timeoutMs ?? 1_800_000,
      )
      releaseLock = completion.confirmed
      run.exitCode = completion.code
      run.output = out
      run.error = completion.error ?? err
      run.status =
        completion.error === undefined && completion.code === 0
          ? 'completed'
          : 'failed'
    } catch (error) {
      run.status = 'failed'
      run.error = String(error)
    } finally {
      run.finishedAt = this.now().toISOString()
      // History persistence and lock cleanup are separate obligations: a failure
      // to write the run must not turn into a permanently held lock.
      try {
        await this.writeRun(run)
      } finally {
        // A process that never confirmed its exit keeps the lock: releasing it would
        // let a second run write the same workspace while the first may still be alive.
        if (releaseLock) await rm(lock, { recursive: true, force: true })
      }
    }
    return run
  }

  /**
   * Waits for the child to actually exit.
   *
   * A timeout sends SIGTERM and waits a bounded grace period before SIGKILL. The
   * promise resolves with `confirmed: false` only when even the forced kill produced
   * no close event, which is the one case where the caller must keep the lock.
   */
  private completeChild(
    child: ReturnType<typeof spawn>,
    timeoutMs: number,
  ): Promise<{ code: number | null; error?: string; confirmed: boolean }> {
    const graceMs = this.opts.killGraceMs ?? 5_000
    return new Promise((resolve) => {
      let settled = false
      let childError: string | undefined
      let timedOut = false
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let forcedTimer: ReturnType<typeof setTimeout> | undefined
      const clearTimers = () => {
        clearTimeout(timeoutTimer)
        clearTimeout(graceTimer)
        clearTimeout(forcedTimer)
      }
      const finish = (code: number | null, confirmed: boolean) => {
        if (settled) return
        settled = true
        clearTimers()
        const timeoutError = timedOut
          ? `automation exceeded ${timeoutMs}ms and ${confirmed ? 'was terminated' : 'did not confirm termination'}`
          : undefined
        resolve({
          code,
          ...(childError === undefined && timeoutError === undefined
            ? {}
            : { error: childError ?? timeoutError }),
          confirmed,
        })
      }
      const signal = (name: NodeJS.Signals) => {
        try {
          child.kill(name)
        } catch (error) {
          childError ??= String(error)
        }
      }
      timeoutTimer = setTimeout(() => {
        timedOut = true
        signal('SIGTERM')
        graceTimer = setTimeout(() => {
          signal('SIGKILL')
          // SIGKILL also completes asynchronously; hold the lock until close proves
          // the process is gone instead of trusting the kill call's return value.
          forcedTimer = setTimeout(() => finish(null, false), graceMs)
        }, graceMs)
      }, timeoutMs)
      child.on('error', (error) => {
        childError = String(error)
        // No pid means the process never started, so no close event is guaranteed.
        if (child.pid === undefined) finish(null, true)
      })
      child.on('close', (code) => finish(code, true))
    })
  }

}
