import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// A Finder-launched .app inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, but the GJC
// launcher is a `#!/usr/bin/env bun` script. Without the interpreter directories on
// PATH the shebang fails with `env: bun: No such file or directory`, so every GJC
// child process must be spawned with these locations appended.
const INTERPRETER_DIRECTORIES = [
  // GJC's installer default (scripts/install.sh: GJC_INSTALL_DIR, default
  // ~/.local/bin). A Finder launch inherits no user directories, so this must be
  // the first fallback: otherwise a stale Bun global install shadows the
  // installer's current gjc on every launch from the .app.
  path.join(homedir(), '.local/bin'),
  path.join(homedir(), '.bun/bin'),
  path.join(homedir(), '.nvm/current/bin'),
  path.join(homedir(), '.volta/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

export function runtimePath(basePath = process.env.PATH ?? ''): string {
  const entries = basePath.split(path.delimiter).filter(Boolean)
  const seen = new Set(entries)
  for (const directory of INTERPRETER_DIRECTORIES) {
    if (seen.has(directory)) continue
    seen.add(directory)
    entries.push(directory)
  }
  return entries.join(path.delimiter)
}

/**
 * GJC's own installer puts the executable in `$GJC_INSTALL_DIR` (default
 * `~/.local/bin`) and then tells the user to put that directory on PATH, so PATH
 * is where an installed GJC is found. This mirrors that contract: the installer's
 * target is searched first, then PATH in its own order.
 *
 * The app previously preferred a fixed list that put `~/.bun/bin` ahead of
 * `~/.local/bin` regardless of PATH, so a stale install shadowed the newer one the
 * terminal ran and `gjc` upgrades did not reach the app.
 */
export function gjcPathCandidates(
  basePath?: string,
  installDirectory = process.env.GJC_INSTALL_DIR,
): string[] {
  const directories = [
    ...(installDirectory ? [installDirectory] : []),
    ...runtimePath(basePath).split(path.delimiter),
  ].filter(Boolean)
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const directory of directories) {
    const candidate = path.join(directory, 'gjc')
    if (seen.has(candidate)) continue
    seen.add(candidate)
    candidates.push(candidate)
  }
  return candidates
}

/** The first candidate that exists and is executable. */
export async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next location.
    }
  }
  return undefined
}

/**
 * Resolves the same GJC the user's shell resolves. A fixed preference list
 * silently disagreed with PATH: `~/.bun/bin` was checked before `~/.local/bin`, so
 * the app ran an older install than the terminal did (0.15.2 against 0.15.3) and
 * an upgrade to the PATH-visible one changed nothing here. An explicit setting or
 * GJC_BIN still wins.
 */
export function resolveGjcExecutable(configured: string | undefined): Promise<string | undefined> {
  return firstExecutable(
    [configured, process.env.GJC_BIN, ...gjcPathCandidates()].filter(
      (candidate): candidate is string => Boolean(candidate),
    ),
  )
}

/** An executable by name in the directories a Finder-launched app searches. */
export function findExecutable(name: string, basePath?: string): Promise<string | undefined> {
  return firstExecutable(
    runtimePath(basePath).split(path.delimiter).map((directory) => path.join(directory, name)),
  )
}

export function runtimeEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return { ...environment, ...extra, PATH: runtimePath(environment.PATH) }
}
