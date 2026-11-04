import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { excludeGjcState, isGitRepository } from './git-exclude'

const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'gajae-exclude-')))

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

function newRepo(name: string): string {
  const repo = path.join(sandbox, name)
  mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(path.join(repo, 'a.txt'), 'a')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

function untracked(repo: string): string {
  return execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: repo, encoding: 'utf8' })
}

describe('excludeGjcState', () => {
  it('hides .gjc/ from git status without touching .gitignore', async () => {
    const repo = newRepo('plain')
    mkdirSync(path.join(repo, '.gjc'))
    writeFileSync(path.join(repo, '.gjc', 'state.json'), '{}')
    expect(untracked(repo)).toContain('.gjc/')

    await excludeGjcState(repo)

    expect(untracked(repo)).toBe('')
    expect(existsSync(path.join(repo, '.gitignore'))).toBe(false)
  })

  it('creates info/exclude when it is missing and stays idempotent', async () => {
    const repo = newRepo('missing')
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    rmSync(exclude)
    await excludeGjcState(repo)
    await excludeGjcState(repo)
    expect(readFileSync(exclude, 'utf8').split('\n').filter((line) => line === '.gjc/')).toHaveLength(1)
  })

  it('keeps existing entries and starts on its own line', async () => {
    const repo = newRepo('existing')
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    writeFileSync(exclude, 'build/')
    await excludeGjcState(repo)
    expect(readFileSync(exclude, 'utf8')).toBe('build/\n.gjc/\n')
  })

  it('writes the main repository exclude when the session runs in a linked worktree', async () => {
    const repo = newRepo('main')
    const linked = path.join(sandbox, 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked)
    mkdirSync(path.join(linked, '.gjc'))
    writeFileSync(path.join(linked, '.gjc', 'state.json'), '{}')

    await excludeGjcState(linked)

    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.gjc/')
    expect(untracked(linked)).toBe('')
  })

  it('does nothing outside a repository and never throws', async () => {
    const plain = path.join(sandbox, 'not-a-repo')
    mkdirSync(plain)
    await expect(excludeGjcState(plain)).resolves.toBeUndefined()
    await expect(excludeGjcState(path.join(sandbox, 'missing-dir'))).resolves.toBeUndefined()
    expect(existsSync(path.join(plain, '.git'))).toBe(false)
  })

  it('does not throw when the exclude path is unwritable', async () => {
    const repo = newRepo('blocked')
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    rmSync(exclude)
    mkdirSync(exclude)
    await expect(excludeGjcState(repo)).resolves.toBeUndefined()
  })
})

describe('isGitRepository', () => {
  it('tells a repository from a plain folder', async () => {
    expect(await isGitRepository(newRepo('detect'))).toBe(true)
    const plain = path.join(sandbox, 'detect-plain')
    mkdirSync(plain)
    expect(await isGitRepository(plain)).toBe(false)
  })
})
