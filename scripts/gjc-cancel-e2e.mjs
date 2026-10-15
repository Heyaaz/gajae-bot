import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js'

const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
// See scripts/gjc-sdk-e2e.mjs: the harness honours the app's own preset override.
const modelPreset = process.env.AGENT_CONTROL_GJC_PRESET?.trim() || undefined
const requestedWorkspace = process.env.AGENT_CONTROL_WORKSPACE?.trim()
const temporaryWorkspace = !requestedWorkspace
const workspace = requestedWorkspace
  ? path.resolve(requestedWorkspace)
  : await mkdtemp(path.join(tmpdir(), 'gajae-cancel-e2e-'))

if (temporaryWorkspace) {
  await execFile('git', ['init', '-q', workspace], { timeout: 10_000 })
  await writeFile(path.join(workspace, 'README.txt'), 'Disposable Gajae cancel E2E workspace.\n')
  await execFile('git', ['-C', workspace, 'add', 'README.txt'], { timeout: 10_000 })
  await execFile(
    'git',
    [
      '-C', workspace,
      '-c', 'user.name=Gajae E2E',
      '-c', 'user.email=gajae-e2e@invalid',
      'commit', '-qm', 'seed',
    ],
    { timeout: 10_000 },
  )
}

const events = []
const controller = new GjcSdkController({
  workspace,
  executable,
  modelPreset,
  permissionHandling: 'always-allow',
  emit: (event) => events.push(event),
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function deadline(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await deadline(
      Promise.resolve().then(predicate),
      Math.min(5_000, end - Date.now()),
      `${label} predicate`,
    )
    if (value) return value
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function assertSupportedVersion(stdout) {
  const match = stdout.match(/(?:gjc\/)?(\d+)\.(\d+)\.(\d+)/u)
  if (!match) throw new Error(`Could not parse GJC version: ${stdout.trim()}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major === 0 && (minor < 18 || (minor === 18 && patch < 11))) {
    throw new Error(`GJC ${major}.${minor}.${patch} is unsupported; install 0.18.11 or newer`)
  }
}

async function brokerRow(sessionId) {
  const { stdout } = await execFile(
    executable,
    ['sdk', 'session', 'list', '--scope', 'all', '--repo', workspace, '--json'],
    { cwd: workspace, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  )
  const envelope = JSON.parse(stdout)
  return envelope?.result?.sessions?.find((row) => row.sessionId === sessionId)
}

let session
try {
  const { stdout: version } = await execFile(executable, ['--version'], {
    cwd: workspace,
    timeout: 15_000,
  })
  assertSupportedVersion(version)

  const connection = await deadline(controller.getConnection(), 30_000, 'broker readiness')
  if (connection.state !== 'connected') {
    throw new Error(`GJC SDK session CLI is unavailable: ${connection.detail}`)
  }

  session = await deadline(
    controller.createSession({
      runtime: 'gjc',
      title: 'SDK terminal abort probe',
      workspace,
      isolation: 'workspace',
    }),
    30_000,
    'session.create',
  )

  const eventStart = events.length
  const prompt = controller.sendMessage(session.id, {
    text: 'Use the bash tool to run `sleep 30`, then reply with exactly FINISHED.',
    images: [],
    files: [],
  })
  await waitFor(
    async () => events.slice(eventStart).some(
      (event) => event.type === 'session.updated'
        && event.session?.id === session.id
        && event.session.status === 'running',
    ),
    10_000,
    'a running turn before abort',
  )

  await deadline(controller.cancelRun(session.id), 30_000, 'terminal owned abort')
  await deadline(prompt.catch(() => undefined), 30_000, 'aborted prompt settlement')

  const afterStatus = (await deadline(controller.listSessions(), 30_000, 'post-abort session list'))
    .find((row) => row.id === session.id)?.status
  if (afterStatus !== 'idle') {
    throw new Error(`Confirmed terminal abort left status ${afterStatus}`)
  }

  const transcript = await deadline(controller.getTranscript(session.id), 30_000, 'post-abort transcript')
  const lengthAtCancel = JSON.stringify(transcript).length
  const notices = transcript
    .filter((item) => item.kind === 'notice')
    .map((item) => item.title)
  if (!notices.includes('작업 취소됨')) {
    throw new Error(`Confirmed abort produced no cancellation notice: ${JSON.stringify(notices)}`)
  }

  await wait(2_000)
  const later = await deadline(controller.getTranscript(session.id), 30_000, 'settled transcript')
  if (JSON.stringify(later).length !== lengthAtCancel) {
    throw new Error('Transcript kept growing after confirmed terminal owned abort')
  }

  console.log(JSON.stringify({
    sdkSessionCli: true,
    terminalAbortVerified: true,
    sessionId: session.id,
    finalStatus: afterStatus,
    transcriptStable: true,
  }, null, 2))
} finally {
  if (session) {
    await deadline(controller.deleteSession(session.id), 20_000, 'session cleanup').catch(() => undefined)
  }
  controller.dispose()
  const row = session
    ? await deadline(brokerRow(session.id), 10_000, 'cleanup verification').catch(() => undefined)
    : undefined
  if (temporaryWorkspace && (!row || row.deleted === true))
    await rm(workspace, { recursive: true, force: true })
  else if (temporaryWorkspace)
    console.error(`Preserved uncertain Gajae cancel E2E workspace for reconciliation: ${workspace}`)
}
