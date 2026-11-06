import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js'

// A skill turn parks on a workflow question (deep-interview's Round 0). Stop must
// end that turn, settle the window to idle, and never print the host's raw reply.
const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
const modelPreset = process.env.AGENT_CONTROL_GJC_PRESET?.trim() || undefined
const workspace = await mkdtemp(path.join(tmpdir(), 'gajae-skill-cancel-e2e-'))
await execFile('git', ['init', '-q', workspace], { timeout: 10_000 })
await writeFile(path.join(workspace, 'README.txt'), 'Disposable Gajae skill cancel E2E workspace.\n')
await execFile('git', ['-C', workspace, 'add', 'README.txt'], { timeout: 10_000 })
await execFile(
  'git',
  ['-C', workspace, '-c', 'user.name=Gajae E2E', '-c', 'user.email=gajae-e2e@invalid', 'commit', '-qm', 'seed'],
  { timeout: 10_000 },
)

const controller = new GjcSdkController({
  workspace,
  executable,
  modelPreset,
  permissionHandling: 'always-allow',
  emit: () => undefined,
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const started = Date.now()
const log = (...args) => console.error(`+${Date.now() - started}ms`, ...args)

async function brokerActivity(sessionId) {
  const { stdout } = await execFile(
    executable,
    ['sdk', 'session', 'list', '--scope', 'all', '--repo', workspace, '--json'],
    { cwd: workspace, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
  )
  return JSON.parse(stdout).result.sessions.find((row) => row.sessionId === sessionId)?.activity?.state
}

const status = async (sessionId) =>
  (await controller.listSessions()).find((row) => row.id === sessionId)?.status

let session
try {
  session = await controller.createSession({
    runtime: 'gjc',
    title: 'Skill stop probe',
    workspace,
    isolation: 'workspace',
  })
  const turn = controller.sendMessage(session.id, {
    text: '/skill:deep-interview 계산기에 곱하기 기능을 추가하고 싶어요',
    images: [],
    files: [],
  })
  turn.catch(() => undefined)

  const waitingOnUser = async () =>
    (await controller.getTranscript(session.id)).some(
      (item) =>
        (item.kind === 'question' && item.status === 'pending') ||
        (item.kind === 'tool' && item.name === 'ask' && item.status === 'running'),
    )
  const deadline = Date.now() + 180_000
  let reached = false
  while (!reached && Date.now() < deadline) {
    reached = await waitingOnUser()
    if (!reached) await wait(1_000)
  }
  if (!reached) throw Object.assign(new Error('the interview never reached a pending question'), { inconclusive: true })
  log('interview is waiting for an answer; status', await status(session.id))

  const messages = []
  const press = async (label) => {
    try {
      await controller.cancelRun(session.id)
      messages.push(`${label}: resolved`)
    } catch (error) {
      messages.push(`${label}: ${error.message}`)
    }
  }
  await press('first stop')
  log(messages.at(-1))

  const finalStatus = await status(session.id)
  const transcriptLength = (await controller.getTranscript(session.id)).length
  await wait(5_000)
  const grown = (await controller.getTranscript(session.id)).length - transcriptLength
  const hostState = await brokerActivity(session.id)
  await press('second stop')
  log(messages.at(-1))

  const failures = []
  if (!messages[0].endsWith('resolved')) failures.push(`first stop did not resolve: ${messages[0]}`)
  if (finalStatus !== 'idle') failures.push(`window still shows ${finalStatus}`)
  if (hostState !== 'idle') failures.push(`GJC host reports ${hostState}`)
  if (grown !== 0) failures.push(`transcript grew by ${grown} rows after the stop`)
  for (const message of messages) {
    if (/[{}]|"ok"|no_active_turn|uncertain/u.test(message)) failures.push(`raw reply leaked: ${message}`)
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify({ sessionId: session.id, finalStatus, hostState, messages }, null, 2))
} catch (error) {
  console.error(error.inconclusive ? `INCONCLUSIVE: ${error.message}` : error.stack)
  process.exitCode = error.inconclusive ? 2 : 1
} finally {
  if (session) await controller.deleteSession(session.id).catch((error) => console.error(`Cleanup: ${error.message}`))
  controller.dispose()
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
}
