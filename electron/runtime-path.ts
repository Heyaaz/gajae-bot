import { homedir } from 'node:os'
import path from 'node:path'

// A Finder-launched .app inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, but the GJC
// launcher is a `#!/usr/bin/env bun` script. Without the interpreter directories on
// PATH the shebang fails with `env: bun: No such file or directory`, so every GJC
// child process must be spawned with these locations appended.
const INTERPRETER_DIRECTORIES = [
  path.join(homedir(), '.bun/bin'),
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

export function runtimeEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return { ...environment, ...extra, PATH: runtimePath(environment.PATH) }
}
