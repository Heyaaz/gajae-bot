import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gjcPathCandidates, runtimePath } from './runtime-path.js'

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

describe('gjcPathCandidates', () => {
  it('follows PATH order so the app picks the same gjc as the shell', () => {
    // The app used a fixed preference list that put ~/.bun/bin ahead of
    // ~/.local/bin regardless of PATH. A stale install in the preferred
    // directory then shadowed the newer one the terminal ran, and upgrading the
    // visible gjc left the app on the old version.
    const local = path.join(homedir(), '.local/bin')
    const bun = path.join(homedir(), '.bun/bin')
    const candidates = gjcPathCandidates(`${local}:${bun}`)

    expect(candidates.indexOf(path.join(local, 'gjc'))).toBeLessThan(
      candidates.indexOf(path.join(bun, 'gjc')),
    )
  })

  it('honours the reverse order too rather than hardcoding a winner', () => {
    const local = path.join(homedir(), '.local/bin')
    const bun = path.join(homedir(), '.bun/bin')
    const candidates = gjcPathCandidates(`${bun}:${local}`)

    expect(candidates.indexOf(path.join(bun, 'gjc'))).toBeLessThan(
      candidates.indexOf(path.join(local, 'gjc')),
    )
  })

  it("searches GJC's own installer target first", () => {
    // scripts/install.sh installs to $GJC_INSTALL_DIR (default ~/.local/bin), so a
    // user who redirected the install must not have the app look elsewhere.
    const custom = '/opt/gjc/bin'
    const candidates = gjcPathCandidates('/usr/bin', custom)

    expect(candidates[0]).toBe(path.join(custom, 'gjc'))
  })

  it('falls back to PATH when no install directory is configured', () => {
    const candidates = gjcPathCandidates('/usr/bin', undefined)

    expect(candidates[0]).toBe('/usr/bin/gjc')
  })

  it('names a gjc in every runtime directory exactly once', () => {
    const candidates = gjcPathCandidates('/usr/bin:/usr/bin')

    expect(candidates.every((candidate) => path.basename(candidate) === 'gjc')).toBe(true)
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('still offers the interpreter directories on a Finder launch PATH', () => {
    // A Finder-launched app inherits only the system directories, so the install
    // locations must still be reachable even though PATH does not mention them.
    const candidates = gjcPathCandidates('/usr/bin:/bin:/usr/sbin:/sbin')

    expect(candidates).toContain(path.join(homedir(), '.local/bin/gjc'))
    expect(candidates).toContain(path.join(homedir(), '.bun/bin/gjc'))
  })
})
