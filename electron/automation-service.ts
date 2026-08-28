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
  constructor(options: AutomationServiceOptions) { if (!path.isAbsolute(options.directory) || !path.isAbsolute(options.gjcExecutable)) throw new Error('automation paths must be absolute'); this.opts = options; this.dir = options.directory; this.launchctl = options.launchctl ?? (() => {}); this.now = options.now ?? (() => new Date()) }
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
  async initialize(): Promise<void> { await mkdir(this.dir, { recursive: true, mode: 0o700 }); if (this.opts.launchAgentsDirectory) await mkdir(this.opts.launchAgentsDirectory, { recursive: true }); for (const item of await this.defs()) { try { await this.sync(item) } catch (error) { console.error(`Automation ${item?.id ?? '(unknown)'} could not be scheduled and was skipped`, error) } } }
  async setGjcExecutable(executable: string): Promise<void> { if (!path.isAbsolute(executable)) throw new Error('GJC executable must be absolute'); this.opts.gjcExecutable = executable; for (const item of await this.defs()) if (item.enabled) await this.sync(item) }
  async list(): Promise<Automation[]> { return (await this.defs()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) }
  async create(input: unknown): Promise<Automation> { const valid = validateAutomationInput(input); const now = this.now().toISOString(); const item: Automation = { ...valid, id: randomUUID(), createdAt: now, updatedAt: now, nextRunAt: this.next(valid.schedule, this.now()) }; const all = await this.defs(); all.push(item); await mkdir(this.dir, { recursive: true }); await atomicJson(this.defsFile(), all); try { await this.sync(item) } catch (error) { await atomicJson(this.defsFile(), all.filter((candidate) => candidate.id !== item.id)); throw error } return item }
  async updateEnabled(id: string, enabled: boolean): Promise<Automation> { if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('invalid input'); const all = await this.defs(); const item = all.find((a) => a.id === id); if (!item) throw new Error('automation not found'); const previous = { enabled: item.enabled, updatedAt: item.updatedAt, nextRunAt: item.nextRunAt }; item.enabled = enabled; item.updatedAt = this.now().toISOString(); item.nextRunAt = enabled ? this.next(item.schedule, this.now()) : null; await atomicJson(this.defsFile(), all); try { await this.sync(item) } catch (error) { Object.assign(item, previous); await atomicJson(this.defsFile(), all); throw error } return item }
  async delete(id: string): Promise<void> { const all = await this.defs(); const item = all.find((a) => a.id === id); if (!item) return; await this.unload(item); await atomicJson(this.defsFile(), all.filter((a) => a.id !== id)); await rm(this.plistPath(id), { force: true }) }
  async listRuns(automationId?: string): Promise<AutomationRun[]> { const runs = await this.runs(); return automationId ? runs.filter((r) => r.automationId === automationId) : runs }
  async runNow(id: string): Promise<AutomationRun> { const item = (await this.defs()).find((a) => a.id === id); if (!item) throw new Error('automation not found'); return this.execute(item) }
  private async sync(item: Automation): Promise<void> { if (this.opts.platform === 'darwin' || (this.opts.platform === undefined && platform() === 'darwin')) { if (item.enabled) { const config = path.join(this.dir, `config-${item.id}.json`); await atomicJson(config, { automation: item, directory: this.dir, gjcExecutable: this.opts.gjcExecutable }); await mkdir(path.dirname(this.plistPath(item.id)), { recursive: true }); try { await this.launchctl(['unload', this.plistPath(item.id)]) } catch { /* A new schedule has nothing to unload. */ } await writeFile(this.plistPath(item.id), automationPlist(`com.gajae.automation.${item.id}`, this.opts.electronPath ?? process.execPath, this.opts.workerPath ?? '', config, item.schedule)); await this.launchctl(['load', this.plistPath(item.id)]) } else await this.unload(item) } }
  private async unload(item: Automation): Promise<void> { if (this.opts.platform === 'darwin' || (this.opts.platform === undefined && platform() === 'darwin')) { await this.launchctl(['unload', this.plistPath(item.id)]); await rm(this.plistPath(item.id), { force: true }) } }
  private next(schedule: AutomationSchedule, from: Date): string { const d = new Date(from); const [h, m] = schedule.time.split(':').map(Number); d.setSeconds(0, 0); d.setHours(h, m); if (schedule.kind === 'weekly') { let delta = (schedule.weekday! - d.getDay() + 7) % 7; if (!delta && d <= from) delta = 7; d.setDate(d.getDate() + delta) } else if (schedule.kind === 'weekdays') { while (d <= from || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1) } else if (d <= from) d.setDate(d.getDate() + 1); return d.toISOString() }
  private async execute(item: Automation): Promise<AutomationRun> { await mkdir(this.dir, { recursive: true }); const lock = path.join(this.dir, `.run-${item.id}.lock`); try { await mkdir(lock) } catch { const skipped = { id: randomUUID(), automationId: item.id, status: 'skipped' as const, startedAt: this.now().toISOString(), finishedAt: this.now().toISOString(), exitCode: null, output: '', error: 'run already in progress' }; await this.writeRun(skipped); return skipped }
    const run: AutomationRun = { id: randomUUID(), automationId: item.id, status: 'running', startedAt: this.now().toISOString(), finishedAt: null, exitCode: null, output: '', error: '' }; await this.writeRun(run)
    try { const args = ['--print']; if (item.modelProfile) args.push('--mpreset', item.modelProfile); if (item.thinking) args.push('--thinking', item.thinking); if (item.worktree) args.push('--worktree'); args.push(item.prompt); const runtimePath = [path.dirname(this.opts.gjcExecutable), path.join(homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter((entry, index, values) => values.indexOf(entry) === index).join(path.delimiter); const child = (this.opts.spawnProcess ?? spawn)(this.opts.gjcExecutable, args, { cwd: item.workspace, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: runtimePath } }); let out = '', err = ''; child.stdout.on('data', (b) => { out = (out + b.toString()).slice(-MAX_OUTPUT) }); child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-MAX_OUTPUT) }); const code = await new Promise<number>((resolve) => { const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(-1) }, this.opts.timeoutMs ?? 1_800_000); child.on('close', (c) => { clearTimeout(timer); resolve(c ?? -1) }) }); run.exitCode = code; run.output = out; run.error = err; run.status = code === 0 ? 'completed' : 'failed' } catch (error) { run.status = 'failed'; run.error = String(error) } finally { run.finishedAt = this.now().toISOString(); await this.writeRun(run); await rm(lock, { recursive: true, force: true }) } return run }
}
