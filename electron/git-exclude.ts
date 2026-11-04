import { execFile as execFileCb } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const GJC_STATE_PATTERN = '.gjc/'
const ALREADY_IGNORED = new Set(['.gjc', '.gjc/', '/.gjc', '/.gjc/'])

/** The repository's shared git directory. A linked worktree's own `.git` is a file, so only this one holds `info/exclude`. */
async function gitCommonDir(workspace: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['-C', workspace, 'rev-parse', '--git-common-dir'])
    const reported = stdout.trim()
    return reported ? path.resolve(workspace, reported) : undefined
  } catch {
    return undefined
  }
}

export async function isGitRepository(workspace: string): Promise<boolean> {
  return (await gitCommonDir(workspace)) !== undefined
}

/**
 * GJC keeps its state in `.gjc/` inside the project, which would otherwise show
 * up as untracked in the user's `git status`. `.git/info/exclude` hides it
 * without editing the user's own `.gitignore`. Best effort: a read-only or
 * unusual repository must not stop a session from starting.
 */
export async function excludeGjcState(workspace: string): Promise<void> {
  try {
    const commonDir = await gitCommonDir(workspace)
    if (!commonDir) return
    const file = path.join(commonDir, 'info', 'exclude')
    const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (current.split(/\r?\n/u).some((line) => ALREADY_IGNORED.has(line.trim()))) return
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${GJC_STATE_PATTERN}\n`)
  } catch {
    // Hiding the folder is a convenience; the session matters more.
  }
}
