import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js'

const workspace = await mkdtemp(path.join(tmpdir(), 'gajae-tool-stream-e2e-'))
execFileSync('git', ['init', '-q', workspace])
await writeFile(path.join(workspace, 'README.txt'), 'Disposable streaming probe.\n')
execFileSync('git', ['-C', workspace, 'add', 'README.txt'])
execFileSync('git', ['-C', workspace, '-c', 'user.name=Gajae E2E', '-c', 'user.email=gajae-e2e@invalid', 'commit', '-qm', 'seed'])
const executable = process.env.GJC_BIN || 'gjc'
const events = []
const controller = new GjcSdkController({
  workspace, executable,
  modelPreset: process.env.AGENT_CONTROL_GJC_PRESET?.trim() || undefined,
  permissionHandling: 'always-allow',
  emit: (event) => {
    if (event.type === 'tool.updated' && event.tool?.name === 'bash') {
      events.push({ ...event.tool })
    }
    if (event.type === 'transcript.appended' && event.item?.kind === 'tool') events.push({ ...event.item })
  },
})
async function deadline(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms) })]) }
  finally { clearTimeout(timer) }
}
let session
try {
  session = await deadline(controller.createSession({ runtime: 'gjc', title: 'Gajae live tool snapshot probe', workspace, isolation: 'workspace' }), 30000, 'create')
  await deadline(controller.sendMessage(session.id, {
    text: 'Use bash exactly once to execute this command: for i in 1 2 3 4 5; do printf "GJCLINE%s\\n" "$i"; sleep 2; done . Do not use background jobs. After it completes, reply DONE. Do not change files.',
    images: [], files: [],
  }), 120000, 'streaming prompt')
  const live = events.filter((tool) => tool.status === 'running' && tool.output?.includes('GJCLINE1') && !tool.output.includes('GJCLINE5'))
  if (!live.length) throw new Error(`No intermediate running-tool snapshot: ${JSON.stringify(events.map(({ status, output }) => ({ status, output })))}`)
  for (const tool of live) {
    if ((tool.output.match(/GJCLINE1/g) || []).length !== 1) throw new Error('Cumulative snapshots were appended instead of replaced')
  }
  const transcript = await controller.getTranscript(session.id)
  const completed = transcript.find((item) => item.kind === 'tool' && item.name === 'bash' && item.status === 'completed' && item.output?.includes('GJCLINE5'))
  if (!completed) throw new Error('No authoritative completed bash result with GJCLINE5')
  console.log(JSON.stringify({ version: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), sessionId: session.id, intermediateSnapshots: live.map(({ status, output }) => ({ status, output })), completed: true }, null, 2))
} finally {
  if (session) await deadline(controller.deleteSession(session.id), 20000, 'cleanup').catch((error) => console.error(`Cleanup: ${error.message}`))
  controller.dispose()
  let deleted = !session
  if (session) {
    try {
      const envelope = JSON.parse(execFileSync(executable, ['sdk', 'session', 'list', '--scope', 'all', '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 }))
      const row = envelope.result?.sessions?.find((item) => item.sessionId === session.id)
      deleted = Array.isArray(envelope.result?.sessions) && (!row || row.deleted === true)
    } catch { /* Unknown cleanup is never authority to delete local evidence. */ }
  }
  if (deleted) await rm(workspace, { recursive: true, force: true })
  else console.error(`Preserved uncertain streaming-probe workspace: ${workspace}`)
}
