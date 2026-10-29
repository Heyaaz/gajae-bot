// A saved session whose broker delete GJC fences with legacy lifecycle history is
// deleted from the app through GJC's own `/session delete`, against the GJC at
// GJC_BIN (default `gjc`). Credential-free and isolated: HOME and the agent dir
// are throwaway, so the interactive GJC imports no credentials from this Mac.
// Run after a build: `node scripts/gjc-cli-delete-e2e.mjs`.
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gajae-cli-delete-e2e-')))
const workspace = path.join(root, 'ws')
const agentDir = path.join(root, 'home', '.gjc', 'agent')
process.env.HOME = path.join(root, 'home')
process.env.GJC_CODING_AGENT_DIR = agentDir
for (const name of Object.keys(process.env)) if (/^(AGENT_CONTROL_|GAJAE_)/u.test(name)) delete process.env[name]
const { GjcSdkController } = await import('../dist-electron/electron/gjc-sdk-controller.js')

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const gjc = async (args) => (await execFile(executable, args, { cwd: workspace, timeout: 60_000 })).stdout
const lifecycle = async (operation, input) => {
  try {
    return JSON.parse(
      await gjc(['sdk', 'session', 'raw', 'global', '--op', operation, '--json-input', JSON.stringify(input),
        '--idempotency-key', randomUUID(), '--json']),
    )
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout)
    throw error
  }
}
const rows = async () => JSON.parse(await gjc(['sdk', 'session', 'list', '--scope', 'all', '--json'])).result.sessions
async function transcripts() {
  const found = []
  for (const bucket of await readdir(path.join(agentDir, 'sessions'), { withFileTypes: true }))
    if (bucket.isDirectory())
      for (const entry of await readdir(path.join(agentDir, 'sessions', bucket.name)))
        if (entry.endsWith('.jsonl')) found.push(path.join(agentDir, 'sessions', bucket.name, entry))
  return found
}
const stopBroker = () => {
  try {
    execFileSync('/usr/bin/pkill', ['-f', `broker-internal --agent-dir ${agentDir}`])
  } catch {
    // pkill exits 1 when nothing matched.
  }
}

let controller
try {
  await mkdir(workspace, { recursive: true })
  await execFile('git', ['init', '-q', workspace])
  const version = (await gjc(['--version'])).trim()
  const created = await lifecycle('session.create', { cwd: workspace })
  assert(created.ok === true, `session.create: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  assert((await lifecycle('session.close', { sessionId, cwd: workspace })).ok === true, 'session closed')
  const [transcript] = await transcripts()
  assert(transcript?.endsWith(`${sessionId}.jsonl`), 'one saved transcript')

  // A legacy row (no operationKey) is what fences deletes on a long-used agent
  // dir. The broker reads it when it starts.
  const legacy = { version: 1, identity: randomBytes(32).toString('hex'), requestHash: randomBytes(32).toString('hex'),
    state: 'accepted', ts: Date.now() - 86_400_000 }
  await appendFile(path.join(agentDir, 'sdk', 'lifecycle-ledger.jsonl'), `${JSON.stringify(legacy)}\n`)
  stopBroker()
  const fenced = await lifecycle('session.delete', { sessionId, cwd: workspace, sessionPath: transcript })
  assert((fenced.diagnostics ?? []).some((d) => d.code === 'lifecycle_legacy_history_ambiguous'),
    `broker delete is fenced, got ${JSON.stringify(fenced.diagnostics ?? fenced.error)}`)

  controller = new GjcSdkController({ workspace, executable, permissionHandling: 'always-allow', emit: () => undefined })
  const startedAt = Date.now()
  await controller.deleteSession(sessionId)
  const elapsedMs = Date.now() - startedAt

  assert((await transcripts()).length === 0, 'no transcript left, including for the session GJC opened after deleting')
  const after = await rows()
  assert(after.every((row) => row.live !== true), `no live session left: ${JSON.stringify(after)}`)
  console.log(JSON.stringify({ version, deletedThroughCli: true, sessionId, elapsedMs, brokerRows: after.length }, null, 2))
} finally {
  controller?.dispose()
  // The broker and session hosts run from this root and write into it while they
  // exit, so the directory goes only after the last of them is gone.
  const running = () => {
    try {
      execFileSync('/usr/bin/pgrep', ['-f', root])
      return true
    } catch {
      return false
    }
  }
  for (let attempt = 0; attempt < 50 && running(); attempt++) {
    try {
      execFileSync('/usr/bin/pkill', ['-f', root])
    } catch {
      // pkill exits 1 when nothing matched.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await rm(root, { recursive: true, force: true })
}
