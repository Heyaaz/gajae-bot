import { homedir } from 'node:os'
import path from 'node:path'

// A Finder-launched .app inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, but the GJC
// launcher is a `#!/usr/bin/env bun` script. Without the interpreter directories on
// PATH the shebang fails with `env: bun: No such file or directory`, so every GJC
// child process must be spawned with these locations appended.
const INTERPRETER_DIRECTORIES = [
  path.join(homedir(), '.bun/bin'),
  // GJC's installer default (scripts/install.sh: GJC_INSTALL_DIR, default
  // ~/.local/bin). A Finder launch inherits no user directories, so this must be
  // present for a normally installed gjc to be found at all.
  path.join(homedir(), '.local/bin'),
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

export function runtimeEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return { ...environment, ...extra, PATH: runtimePath(environment.PATH) }
}
