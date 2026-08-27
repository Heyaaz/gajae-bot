import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { GjcUpdateStatus } from '../shared/agent-contract.js'

const execFile = promisify(execFileCallback)
const VERSION_PATTERN = /(?:gjc\/|Current version:\s*)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const AVAILABLE_PATTERN = /New version available:\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const UP_TO_DATE_PATTERN = /up[ -]to[ -]date|latest version|no updates?/iu

type UpdateRunner = (executable: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

export function parseGjcUpdateCheck(output: string): GjcUpdateStatus {
  const currentVersion = output.match(VERSION_PATTERN)?.[1]
  if (!currentVersion) throw new Error('GJC 업데이트 확인 결과에서 현재 버전을 읽지 못했습니다.')
  const latestVersion = output.match(AVAILABLE_PATTERN)?.[1] ?? currentVersion
  const updateAvailable = latestVersion !== currentVersion && !UP_TO_DATE_PATTERN.test(output)
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
  const result = await execFile(executable, args, {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}
