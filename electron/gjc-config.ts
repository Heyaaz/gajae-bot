import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { GjcSetting, GjcSettingChange } from '../shared/gjc-settings.js'
import { runtimeEnvironment } from './runtime-path.js'

const execFile = promisify(execFileCallback)

export type ConfigRunner = (executable: string, args: string[]) => Promise<{ stdout: string }>

// Settings that only shape the terminal UI, plus `sdk.*`, whose broker deadlines
// the app's own session control depends on.
const HIDDEN_ROOTS = new Set([
  'autocompleteMaxVisible', 'clearOnShrink', 'collapseChangelog', 'colorBlindMode',
  'display', 'emojiAutocomplete', 'hideThinkingBlock', 'mouse', 'sdk',
  'showHardwareCursor', 'startup', 'statusLine', 'syntaxHighlighting', 'tasksPane',
  'terminal', 'theme', 'tui',
])
const HIDDEN_KEYS = new Set([
  'goal.statusInFooter', 'irc.sidebar.enabled', 'notifications.terminalBell',
  'notifications.bellOnComplete', 'notifications.bellOnApproval', 'notifications.bellOnAsk',
])

export function editableGjcSettings(listing: unknown): GjcSetting[] {
  if (!listing || typeof listing !== 'object' || Array.isArray(listing))
    throw new Error('gjc config list returned an unexpected shape')
  const settings: GjcSetting[] = []
  for (const [key, entry] of Object.entries(listing)) {
    if (HIDDEN_KEYS.has(key) || HIDDEN_ROOTS.has(key.split('.')[0]!)) continue
    if (!entry || typeof entry !== 'object') continue
    const { type, value, description } = entry as Record<string, unknown>
    if (type !== 'boolean' && type !== 'number') continue
    if (value !== null && typeof value !== type) continue
    if (type === 'number' && value !== null && !Number.isFinite(value)) continue
    settings.push({
      key,
      type,
      value: value as GjcSetting['value'],
      ...(typeof description === 'string' && description ? { description } : {}),
    })
  }
  return settings.sort((left, right) => left.key.localeCompare(right.key))
}

export async function listGjcSettings(executable: string, runner: ConfigRunner = run): Promise<GjcSetting[]> {
  const { stdout } = await runner(executable, ['config', 'list', '--json'])
  return editableGjcSettings(JSON.parse(stdout))
}

/**
 * Applies only changes to keys the current listing offers, with a value of the
 * listed type, so the renderer cannot reach hidden or secret settings.
 */
export async function applyGjcSettings(
  executable: string,
  changes: readonly GjcSettingChange[],
  runner: ConfigRunner = run,
): Promise<GjcSetting[]> {
  const offered = new Map((await listGjcSettings(executable, runner)).map((setting) => [setting.key, setting]))
  for (const change of changes) {
    const setting = offered.get(change.key)
    if (!setting) throw new Error(`GJC setting ${change.key} cannot be changed here`)
    if (typeof change.value !== setting.type || (setting.type === 'number' && !Number.isFinite(change.value)))
      throw new Error(`GJC setting ${change.key} needs a ${setting.type}`)
  }
  for (const change of changes)
    await runner(executable, ['config', 'set', change.key, String(change.value)])
  return listGjcSettings(executable, runner)
}

async function run(executable: string, args: string[]): Promise<{ stdout: string }> {
  const result = await execFile(executable, args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: runtimeEnvironment(),
  })
  return { stdout: result.stdout }
}
