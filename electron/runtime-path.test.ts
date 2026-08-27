import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runtimePath } from './runtime-path.js'

describe('runtimePath', () => {
  it('adds interpreter directories to the minimal Finder launch PATH', () => {
    const resolved = runtimePath('/usr/bin:/bin:/usr/sbin:/sbin').split(path.delimiter)

    expect(resolved.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(resolved).toContain(path.join(homedir(), '.bun/bin'))
    expect(resolved).toContain('/opt/homebrew/bin')
  })

  it('preserves existing entries and their precedence without duplicating them', () => {
    const bunDirectory = path.join(homedir(), '.bun/bin')
    const resolved = runtimePath(`${bunDirectory}:/usr/bin`).split(path.delimiter)

    expect(resolved[0]).toBe(bunDirectory)
    expect(resolved.filter((entry) => entry === bunDirectory)).toHaveLength(1)
  })

  it('still yields interpreter directories when PATH is empty', () => {
    const resolved = runtimePath('').split(path.delimiter)

    expect(resolved).toContain(path.join(homedir(), '.bun/bin'))
    expect(resolved.every(Boolean)).toBe(true)
  })
})
