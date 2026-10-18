import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { GjcUpdateStatus } from '../shared/agent-contract.js'
import { runtimeEnvironment } from './runtime-path.js'

const execFile = promisify(execFileCallback)
const VERSION_PATTERN = /(?:gjc\/|Current version:\s*)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const AVAILABLE_PATTERN = /New version available:\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const UP_TO_DATE_PATTERN = /up[ -]to[ -]date|latest version|no updates?/iu

type UpdateRunner = (executable: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

/**
 * Reads `gjc update --check` output.
 *
 * The command has no `--json` mode (confirmed on gjc/0.15.3), so its human text is the
 * only signal there is. That makes the order of evidence matter: a named version is a
 * fact the command stated, while the up-to-date phrase is a summary line that can be
 * left over from a progress step or a cached notice. Letting the phrase veto the named
 * version reported "no update" for output that offered one, which hid the update from
 * the user. A concrete version therefore wins, and the phrase only decides when no
 * version was offered.
 */
export function parseGjcUpdateCheck(output: string): GjcUpdateStatus {
  const currentVersion = output.match(VERSION_PATTERN)?.[1]
  if (!currentVersion) throw new Error('GJC 업데이트 확인 결과에서 현재 버전을 읽지 못했습니다.')
  const offered = output.match(AVAILABLE_PATTERN)?.[1]
  const latestVersion = offered ?? currentVersion
  const updateAvailable = offered
    ? offered !== currentVersion
    : latestVersion !== currentVersion && !UP_TO_DATE_PATTERN.test(output)
  return { currentVersion, latestVersion, updateAvailable }
}

export async function checkGjcUpdate(executable: string, runner: UpdateRunner = run): Promise<GjcUpdateStatus> {
  const result = await runner(executable, ['update', '--check'])
  return parseGjcUpdateCheck(`${result.stdout}\n${result.stderr}`)
}

export async function installGjcUpdate(executable: string, runner: UpdateRunner = run): Promise<GjcUpdateStatus> {
  await runner(executable, ['update'])
  return checkGjcUpdate(executable, runner)
}

async function run(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  // The updater receives the bare name `gjc` when no explicit path is configured.
  // A Finder launch inherits only the system PATH, so it must spawn with the same
  // interpreter/install directories as the session controller or every update
  // check fails with ENOENT on a normally installed GJC.
  const result = await execFile(executable, args, {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: runtimeEnvironment(),
  })
  return { stdout: result.stdout, stderr: result.stderr }
}
