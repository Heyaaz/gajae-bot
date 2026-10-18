import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { homedir } from 'node:os'
import type { Automation, AutomationInput, AutomationRun, AutomationSchedule } from '../shared/automation-ipc.js'

/** A recovery guard this old belongs to a worker that died mid-recovery. */
const LOCK_RECOVERY_STALE_MS = 30_000

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

/** A launchd wake after this much delay is treated as a missed run, not an on-time one. */
export const AUTOMATION_CATCH_UP_GRACE_MS = 5 * 60_000
/** Only the most recent missed occurrence inside this window is made up. */
export const AUTOMATION_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60_000

export type AutomationRunPlan =
  | { kind: 'scheduled' | 'catch-up'; scheduledFor: string; reason?: string }
  | { kind: 'missed-window'; scheduledFor: string; reason: string }

export type AutomationCatchUpDecision =
  | { kind: 'scheduled' }
  | { kind: 'catch-up'; reason: string }
  | { kind: 'missed-window'; reason: string }

/** Applies the age policy to one occurrence, independent of how it was found. */
export function catchUpDecision(
  scheduledFor: Date,
  now: Date,
): AutomationCatchUpDecision {
  const lateMs = now.getTime() - scheduledFor.getTime()
  if (lateMs > AUTOMATION_CATCH_UP_WINDOW_MS)
    return { kind: 'missed-window', reason: '7일이 지난 놓친 실행은 보충하지 않습니다.' }
  if (lateMs <= AUTOMATION_CATCH_UP_GRACE_MS) return { kind: 'scheduled' }
  return {
    kind: 'catch-up',
    reason: '잠자기 등으로 예약 시각보다 늦게 보충 실행했습니다.',
  }
}

/**
 * The most recent scheduled occurrence at or before `now`.
 *
 * launchd does not hand the worker the occurrence that woke it, so the worker
 * derives it from the same schedule the plist carries. Walking backwards over
 * local dates keeps daily, weekday, and weekly rules on the user's own calendar
 * across daylight-saving changes.
 */
export function latestScheduledOccurrence(
  schedule: AutomationSchedule,
  now: Date,
): Date {
  const [hour, minute] = schedule.time.split(':').map(Number)
  const occurrence = new Date(now)
  occurrence.setSeconds(0, 0)
  occurrence.setHours(hour, minute)
  const allowed = (date: Date): boolean =>
    schedule.kind !== 'weekdays' ||
    (date.getDay() !== 0 && date.getDay() !== 6)
  while (
    occurrence > now ||
    !allowed(occurrence) ||
    (schedule.kind === 'weekly' && occurrence.getDay() !== schedule.weekday)
  )
    occurrence.setDate(occurrence.getDate() - 1)
  return occurrence
}

/**
 * Applies the missed-run policy to the occurrence launchd just woke for.
 *
 * The most recent missed occurrence is made up once when it is at most a week
 * old. Anything older is recorded as skipped with its reason instead of being
 * run: catching up a week of daily prompts in one burst was never the promise,
 * and the history has to say why the gap stayed empty.
 */
export function automationRunPlan(
  schedule: AutomationSchedule,
  now: Date,
): AutomationRunPlan {
  const occurrence = latestScheduledOccurrence(schedule, now)
  const scheduledFor = occurrence.toISOString()
  const decision = catchUpDecision(occurrence, now)
  if (decision.kind === 'scheduled')
    return { kind: 'scheduled', scheduledFor }
  return {
    kind: decision.kind,
    scheduledFor,
    reason: decision.reason,
  }
}

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
  private async defs(): Promise<Automation[]> {
    let raw: string
    try {
      raw = await readFile(this.defsFile(), 'utf8')
    } catch (error) {
      // Only a missing file is an empty definition set. A permission or I/O
      // failure must not be presented as "no automations", because the next save
      // would then overwrite definitions that are still there.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`자동화 정의를 읽을 수 없습니다. 기존 설정을 덮어쓰지 않았습니다: ${String(error)}`)
    }
    try {
      const value: unknown = JSON.parse(raw)
      if (!Array.isArray(value)) throw new Error('the definition file is not a list')
      return value as Automation[]
    } catch (error) {
      // Keep the unreadable document next to the original so the user can inspect
      // or recover it; the original is never rewritten by this path.
      // A content-addressed name keeps one copy per damaged revision instead of a
      // new file for every failed read.
      const evidence = `${this.defsFile()}.corrupt-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
      await writeFile(evidence, raw, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined)
      throw new Error(`자동화 정의 파일이 손상되어 읽을 수 없습니다. 원본과 복구 사본을 보존했습니다: ${evidence}. ${String(error)}`)
    }
  }
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
  async runNow(id: string): Promise<AutomationRun> { const item = (await this.defs()).find((a) => a.id === id); if (!item) throw new Error('automation not found'); return this.execute(item, { trigger: 'manual' }) }

  /**
   * Runs the occurrence launchd woke for, applying the catch-up policy.
   *
   * `now` is injectable so the wake-after-sleep behavior is a test, not an
   * assumption about how launchd coalesces missed calendar intervals.
   */
  async runScheduled(id: string, now = this.now()): Promise<AutomationRun> {
    const item = (await this.defs()).find((a) => a.id === id)
    if (!item) throw new Error('automation not found')
    if (!item.enabled)
      return this.skipRun(item, {
        trigger: 'scheduled',
        reason: '자동화가 비활성화되어 있습니다.',
      })
    const plan = automationRunPlan(item.schedule, now)
    if (plan.kind === 'missed-window')
      return this.skipRun(item, {
        trigger: 'catch-up',
        scheduledFor: plan.scheduledFor,
        reason: plan.reason,
      })
    if (plan.kind === 'catch-up') {
      const alreadyCovered = (await this.runs()).some(
        (run) =>
          run.automationId === item.id &&
          run.scheduledFor === plan.scheduledFor &&
          run.status !== 'skipped',
      )
      if (alreadyCovered)
        return this.skipRun(item, {
          trigger: 'catch-up',
          scheduledFor: plan.scheduledFor,
          reason: '이미 보충 실행된 예약입니다.',
        })
    }
    return this.execute(item, {
      trigger: plan.kind,
      scheduledFor: plan.scheduledFor,
      ...(plan.reason ? { reason: plan.reason } : {}),
    })
  }

  private async skipRun(
    item: Automation,
    options: {
      trigger: 'scheduled' | 'catch-up' | 'manual'
      scheduledFor?: string
      reason: string
    },
  ): Promise<AutomationRun> {
    const at = this.now().toISOString()
    const skipped: AutomationRun = {
      id: randomUUID(),
      automationId: item.id,
      status: 'skipped',
      trigger: options.trigger,
      ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}),
      reason: options.reason,
      startedAt: at,
      finishedAt: at,
      exitCode: null,
      output: '',
      error: options.reason,
    }
    await this.writeRun(skipped)
    return skipped
  }
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

    // Serialize recovery with a guard. Two recoverers that read the same stale
    // token must not both rename: the second can otherwise move the first
    // recoverer's brand-new live lock out of the way, and a third run can then
    // start beside it. Holding the guard across the whole replace transaction
    // makes only one process move the stale directory.
    const guard = `${lock}.recover`
    const guardFile = await this.claimRecovery(guard)
    if (!guardFile) return undefined
    try {
      // Re-read under the guard. The directory may have changed between the
      // first inspection and this claim.
      const current = await this.readLockOwner(lock)
      if (
        !current ||
        current.token !== inspected.token ||
        lockOwnerAlive(current)
      )
        return undefined
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
    } finally {
      await guardFile.close().catch(() => undefined)
      await rm(guard, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Claims the recovery guard, cleaning one left by a worker that died mid-way.
   * Losing the claim means another worker is already recovering, so this run
   * skips instead of racing it.
   */
  private async claimRecovery(
    guard: string,
  ): Promise<Awaited<ReturnType<typeof open>> | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await open(guard, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const info = await stat(guard).catch(() => undefined)
        if (!info || Date.now() - info.mtimeMs < LOCK_RECOVERY_STALE_MS)
          return undefined
        await rm(guard, { force: true }).catch(() => undefined)
      }
    }
    return undefined
  }

  /** Removes the lock only while it still belongs to this run. */
  private async releaseLock(
    lock: string,
    owner: AutomationLockOwner,
  ): Promise<void> {
    const current = await this.readLockOwner(lock)
    if (!current || current.token !== owner.token) return
    await rm(lock, { recursive: true, force: true })
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

  private async execute(
    item: Automation,
    options: {
      trigger: 'scheduled' | 'catch-up' | 'manual'
      scheduledFor?: string
      reason?: string
    },
  ): Promise<AutomationRun> {
    await mkdir(this.dir, { recursive: true })
    const lock = path.join(this.dir, `.run-${item.id}.lock`)
    const owner = await this.acquireLock(lock, item.id)
    if (!owner)
      return this.skipRun(item, {
        trigger: options.trigger,
        ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}),
        reason: '이전 실행이 아직 진행 중입니다.',
      })
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: item.id,
      status: 'running',
      trigger: options.trigger,
      ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
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
      await this.releaseLock(lock, owner)
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
      // Install the output and completion listeners synchronously after spawn.
      // Recording the pid below is file I/O; a child that exits quickly may emit
      // close before that write resolves, and a listener attached afterwards would
      // never see it.
      let out = ''
      let err = ''
      child.stdout?.on('data', (b) => {
        out = (out + b.toString()).slice(-MAX_OUTPUT)
      })
      child.stderr?.on('data', (b) => {
        err = (err + b.toString()).slice(-MAX_OUTPUT)
      })
      const completion = this.completeChild(
        child,
        this.opts.timeoutMs ?? 1_800_000,
        // The response must not wait forever for a process that ignored SIGKILL, but
        // its later exit is still proof the workspace lock is safe to release.
        () => {
          void this.releaseLock(lock, owner).catch(() => undefined)
        },
      )
      // Record the process a later worker must see as alive when deciding whether
      // this lock is stale. The worker can exit while its GJC child keeps running.
      await this.recordLockChild(lock, owner, child.pid).catch(() => undefined)
      const result = await completion
      releaseLock = result.confirmed
      run.exitCode = result.code
      run.output = out
      run.error = result.error ?? err
      run.status =
        result.error === undefined && result.code === 0
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
        if (releaseLock) await this.releaseLock(lock, owner)
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
    onLateExit?: (code: number | null) => void,
  ): Promise<{ code: number | null; error?: string; confirmed: boolean }> {
    const graceMs = this.opts.killGraceMs ?? 5_000
    return new Promise((resolve) => {
      let settled = false
      let lateExitReported = false
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
      child.on('close', (code) => {
        if (settled) {
          // Completion already resolved as unconfirmed. A later close is still the
          // only proof the process is gone, so hand it to the owner instead of
          // dropping it on the floor.
          if (!lateExitReported) {
            lateExitReported = true
            onLateExit?.(code)
          }
          return
        }
        finish(code, true)
      })
    })
  }

}
