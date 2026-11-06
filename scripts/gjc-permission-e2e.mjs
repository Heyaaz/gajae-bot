import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js'

// A `prompt` session must show a bash call that needs approval on its tool card
// (`approval-required` with options), keep showing it while GJC waits (session file
// reads rebuild rows meanwhile), and allowing it there must run the command.
const workspace = await mkdtemp(path.join(tmpdir(), 'gajae-permission-e2e-'))
execFileSync('git', ['init', '-q', workspace])
await writeFile(path.join(workspace, 'README.txt'), 'Disposable approval probe.\n')
execFileSync('git', ['-C', workspace, 'add', 'README.txt'])
execFileSync('git', ['-C', workspace, '-c', 'user.name=Gajae E2E', '-c', 'user.email=gajae-e2e@invalid', 'commit', '-qm', 'seed'])
const executable = process.env.GJC_BIN || 'gjc'
const marker = `GAJAEOK${process.pid}`
const started = Date.now()
const log = (...args) => console.error(`+${Date.now() - started}ms`, ...args)
let resolveCard
const card = new Promise((resolve) => { resolveCard = resolve })
const controller = new GjcSdkController({
  workspace, executable,
  modelPreset: process.env.AGENT_CONTROL_GJC_PRESET?.trim() || undefined,
  permissionHandling: 'prompt',
  emit: (event) => {
    if (event.type === 'session.updated') log('session', event.session.status, event.session.approvalChannel ?? '', event.session.status === 'failed' ? JSON.stringify(event.session).slice(0, 600) : '')
    if (event.type === 'tool.updated' && event.tool?.name === 'bash') {
      log('tool', event.tool.id, event.tool.status, event.tool.permissionOptions?.length ?? 0)
      if (event.tool.status === 'approval-required' && event.tool.permissionOptions?.length) resolveCard(event.tool)
    }
  },
})
async function deadline(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms) })]) }
  finally { clearTimeout(timer) }
}
let session
try {
  session = await deadline(controller.createSession({ runtime: 'gjc', title: 'Gajae approval probe', workspace, isolation: 'workspace' }), 30000, 'create')
  const turn = controller.sendMessage(session.id, {
    text: `Use bash exactly once to run: echo ${marker} . Then reply DONE. Do not change files.`,
    images: [], files: [],
  })
  turn.catch(() => undefined)
  const tool = await deadline(card, 50000, 'approval card (approval-required with options) for the bash call')
  await new Promise((resolve) => setTimeout(resolve, 15000))
  const waiting = (await controller.getTranscript(session.id)).find((item) => item.id === tool.id)
  if (waiting?.status !== 'approval-required' || !waiting.permissionOptions?.length) throw new Error(`Card stopped waiting before a decision: ${JSON.stringify({ status: waiting?.status, options: waiting?.permissionOptions?.length })}`)
  const allow = tool.permissionOptions.find((option) => option.kind === 'allow_once')
  await controller.resolveToolCall(tool.id, { optionId: allow.optionId })
  await deadline(turn, 90000, 'turn after approval')
  const transcript = await controller.getTranscript(session.id)
  const ran = transcript.find((item) => item.kind === 'tool' && item.name === 'bash' && item.output?.includes(marker))
  if (!ran) throw new Error(`Approved bash did not run: ${JSON.stringify(transcript.filter((item) => item.kind === 'tool').map(({ status, output }) => ({ status, output })))}`)
  console.log(JSON.stringify({ version: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), sessionId: session.id, card: true, ran: ran.status }, null, 2))
} finally {
  if (session) await deadline(controller.deleteSession(session.id), 20000, 'cleanup').catch((error) => console.error(`Cleanup: ${error.message}`))
  controller.dispose()
  await rm(workspace, { recursive: true, force: true })
}
