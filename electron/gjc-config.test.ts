import { describe, expect, it } from 'vitest'
import { applyGjcSettings, editableGjcSettings, listGjcSettings, type ConfigRunner } from './gjc-config'

const LISTING = {
  'retry.enabled': { type: 'boolean', value: true, description: 'Retry failed requests' },
  'retry.maxRetries': { type: 'number', value: 3, description: '' },
  'power.preventIdleSleep': { type: 'boolean', value: null, description: 'Keep the Mac awake' },
  'theme.dark': { type: 'string', value: 'codex', description: 'Theme' },
  'statusLine.maxRows': { type: 'number', value: 2, description: 'Status rows' },
  'sdk.promptDeadlineMs': { type: 'number', value: 1000, description: 'Deadline' },
  'notifications.terminalBell': { type: 'boolean', value: false, description: 'Bell' },
  'compaction.thresholdPercent': { type: 'number', value: 'eighty', description: 'Wrong type' },
}

function fakeGjc(initial: Record<string, { type: string; value: unknown; description?: string }> = LISTING) {
  const listing = structuredClone(initial)
  const calls: string[][] = []
  const runner: ConfigRunner = async (_executable, args) => {
    calls.push(args)
    if (args[1] === 'set') {
      const entry = listing[args[2]!]!
      entry.value = entry.type === 'boolean' ? args[3] === 'true' : Number(args[3])
    }
    return { stdout: JSON.stringify(listing) }
  }
  return { runner, calls }
}

describe('editableGjcSettings', () => {
  it('keeps boolean and number settings that apply to app sessions', () => {
    expect(editableGjcSettings(LISTING)).toEqual([
      { key: 'power.preventIdleSleep', type: 'boolean', value: null, description: 'Keep the Mac awake' },
      { key: 'retry.enabled', type: 'boolean', value: true, description: 'Retry failed requests' },
      { key: 'retry.maxRetries', type: 'number', value: 3 },
    ])
  })

  it('refuses a listing that is not an object', () => {
    expect(() => editableGjcSettings([])).toThrow('unexpected shape')
  })
})

describe('applyGjcSettings', () => {
  it('sets each change through gjc config and returns the fresh listing', async () => {
    const gjc = fakeGjc()
    const settings = await applyGjcSettings('gjc', [
      { key: 'retry.enabled', value: false },
      { key: 'retry.maxRetries', value: 5 },
    ], gjc.runner)
    expect(gjc.calls).toContainEqual(['config', 'set', 'retry.enabled', 'false'])
    expect(gjc.calls).toContainEqual(['config', 'set', 'retry.maxRetries', '5'])
    expect(settings.find((setting) => setting.key === 'retry.maxRetries')?.value).toBe(5)
  })

  it('writes nothing when any change targets a hidden key or the wrong type', async () => {
    for (const changes of [
      [{ key: 'retry.enabled', value: false }, { key: 'sdk.promptDeadlineMs', value: 1 }],
      [{ key: 'retry.maxRetries', value: true }],
      [{ key: 'unknown.key', value: true }],
    ]) {
      const gjc = fakeGjc()
      await expect(applyGjcSettings('gjc', changes, gjc.runner)).rejects.toThrow()
      expect(gjc.calls.some((args) => args[1] === 'set')).toBe(false)
    }
  })

  it('lists through gjc config list --json', async () => {
    const gjc = fakeGjc()
    await listGjcSettings('gjc', gjc.runner)
    expect(gjc.calls).toEqual([['config', 'list', '--json']])
  })
})
