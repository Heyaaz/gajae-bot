import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js'

const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
// The default preset is codex-medium; this override keeps the harness runnable on a
// machine whose default provider credentials are not usable, the same way main.ts
// honours AGENT_CONTROL_GJC_PRESET for the app itself.
const modelPreset = process.env.AGENT_CONTROL_GJC_PRESET?.trim() || undefined
const requestedWorkspace = process.env.AGENT_CONTROL_WORKSPACE?.trim()
const temporaryWorkspace = !requestedWorkspace
const workspace = requestedWorkspace
  ? path.resolve(requestedWorkspace)
  : await mkdtemp(path.join(tmpdir(), 'gajae-sdk-e2e-'))

if (temporaryWorkspace) {
  await execFile('git', ['init', '-q', workspace], { timeout: 10_000 })
  await writeFile(path.join(workspace, 'README.txt'), 'Disposable Gajae SDK E2E workspace.\n')
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

// Each verified surface is announced as it passes: this suite runs for minutes and
// covers several independent surfaces, so a later failure must not hide the ones
// that already held.
const step = (message) => console.log(`ok ${message}`)

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

function assertSupportedVersion(stdout) {
  const match = stdout.match(/(?:gjc\/)?(\d+)\.(\d+)\.(\d+)/u)
  if (!match) throw new Error(`Could not parse GJC version: ${stdout.trim()}`)
  const actual = match.slice(1).map(Number)
  const minimum = [0, 18, 12]
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return
    if (actual[index] < minimum[index]) {
      throw new Error(`GJC ${actual.join('.')} is unsupported; install 0.18.12 or newer`)
    }
  }
}

async function rawGlobal(operation, input) {
  try {
    // The raw global verb takes no --repo in gjc/0.18.11; passing one is a usage error.
    const result = await execFile(
      executable,
      [
        'sdk', 'session', 'raw', 'global',
        '--op', operation,
        '--idempotency-key', `gajae-e2e-${operation.replace('.', '-')}-${randomUUID()}`,
        '--json-input', JSON.stringify(input),
        '--json',
      ],
      { cwd: workspace, maxBuffer: 1024 * 1024, timeout: 30_000 },
    )
    return JSON.parse(result.stdout)
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    if (stdout) {
      const envelope = JSON.parse(stdout)
      if (envelope?.error?.code === 'terminal_uncertain') return envelope
    }
    throw error
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

async function waitForDeleted(sessionId, label) {
  try {
    return await waitFor(async () => {
      const row = await brokerRow(sessionId)
      return !row || row.deleted === true
    }, 15_000, label)
  } catch (error) {
    // Report the evidence the predicate saw: an unknown-outcome lifecycle call
    // preserves the row on purpose, and the row is what says why.
    const row = await brokerRow(sessionId).catch(() => undefined)
    throw new Error(
      `${error.message}; broker row ${JSON.stringify({
        live: row?.live ?? null,
        deleted: row?.deleted ?? null,
        activity: row?.activityState ?? null,
        generation: row?.endpointGeneration ?? null,
      })}`,
    )
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const remaining = end - Date.now()
    const value = await deadline(
      Promise.resolve().then(predicate),
      Math.min(5_000, remaining),
      `${label} predicate`,
    )
    if (value) return value
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function transcriptText(items, role) {
  return items
    .filter((item) => item.kind === 'message' && item.role === role)
    .map((item) => item.content)
    .join('')
}

let session
let forked
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

  const before = await deadline(controller.listSessions(), 30_000, 'initial session list')
  session = await deadline(
    controller.createSession({
      runtime: 'gjc',
      title: 'Gajae SDK session check',
      workspace,
      isolation: 'workspace',
    }),
    30_000,
    'session.create',
  )

  await deadline(
    controller.sendMessage(session.id, {
      text: 'Do not use tools or modify files. Reply with exactly: GJC_CONNECTED',
      images: [],
      files: [],
    }),
    120_000,
    'semantic send',
  )
  const transcript = await deadline(controller.getTranscript(session.id), 30_000, 'initial transcript')
  const userText = transcriptText(transcript, 'user')
  const assistantText = transcriptText(transcript, 'assistant')
  if (!userText.includes('GJC_CONNECTED')) throw new Error('GJC did not persist the SDK user message')
  if (!assistantText.includes('GJC_CONNECTED')) {
    throw new Error(`Unexpected GJC response: ${assistantText || '<empty>'}`)
  }

  // A real tool boundary makes the busy window stable enough to prove persistent
  // steering. The durable transcript must contain the steered result.
  const steerEventStart = events.length
  const steeredPrompt = controller.sendMessage(session.id, {
    text: 'Use the bash tool to run `sleep 15`, then reply with exactly SLEPT.',
    images: [],
    files: [],
  })
  await waitFor(
    async () => events.slice(steerEventStart).some(
      (event) => event.type === 'session.updated'
        && event.session?.id === session.id
        && event.session.status === 'running',
    ),
    10_000,
    'the steer probe to start',
  )
  const delivery = await deadline(
    controller.sendMessage(session.id, {
      text: '/steer stop counting and reply with exactly STEERED',
      images: [],
      files: [],
    }),
    30_000,
    'turn.steer',
  )
  if (delivery !== 'steer') throw new Error(`Busy follow-up was delivered as ${delivery}`)
  step(`semantic send replied ${assistantText}`)
  step('follow-up during a run was delivered as a steer')
  await deadline(steeredPrompt, 120_000, 'steered prompt settlement')
  await waitFor(async () => {
    const steeredTranscript = await controller.getTranscript(session.id)
    const text = transcriptText(steeredTranscript, 'assistant')
    return text.includes('STEERED') ? text : undefined
  }, 45_000, 'durable steer result')

  // Stop must be a confirmed terminal owned abort. It must reach idle and the
  // durable transcript must stop changing; no process signal is involved.
  //
  // gjc/0.18.11 cannot confirm one over the broker route: it answers
  // `{turn:"no_active_turn", terminal:"terminal_no_effect"}` while the turn is
  // verifiably running and the run continues (see README, "Known limitation on
  // 0.18.11"). That is recorded as a failure, but only after the remaining
  // lifecycle checks have run, so one unavailable surface does not hide the rest.
  const failures = [];
  const abortEventStart = events.length;
  const abortPrompt = controller.sendMessage(session.id, {
    text: 'Use the bash tool to run `sleep 30`, then reply with exactly FINISHED.',
    images: [],
    files: [],
  });
  await waitFor(
    async () => events.slice(abortEventStart).some(
      (event) => event.type === 'session.updated'
        && event.session?.id === session.id
        && event.session.status === 'running',
    ),
    10_000,
    'the abort probe to start',
  );
  let abortConfirmed = false;
  try {
    await deadline(controller.cancelRun(session.id), 30_000, 'terminal owned abort');
    abortConfirmed = true;
  } catch (error) {
    failures.push(`terminal owned abort was not confirmed: ${error?.message ?? error}`);
  }
  if (abortConfirmed) {
    step('terminal owned abort was confirmed')
    await deadline(abortPrompt.catch(() => undefined), 30_000, 'aborted prompt settlement');
    const afterAbort = await deadline(controller.getTranscript(session.id), 30_000, 'post-abort transcript');
    const afterAbortSize = JSON.stringify(afterAbort).length;
    await wait(2_000);
    const settledAfterAbort = await deadline(
      controller.getTranscript(session.id),
      30_000,
      'abort settling transcript',
    );
    if (JSON.stringify(settledAfterAbort).length !== afterAbortSize) {
      failures.push('transcript kept growing after a confirmed terminal owned abort');
    }
    const abortedRow = (await deadline(controller.listSessions(), 30_000, 'post-abort session list'))
      .find((row) => row.id === session.id);
    if (abortedRow?.status !== 'idle') {
      failures.push(`confirmed terminal abort left session status ${abortedRow?.status}`);
    }
  } else {
    // The run the app could not stop keeps going on its own; let it reach its own
    // end before the lifecycle checks below so they run against a quiet session.
    await deadline(abortPrompt.catch(() => undefined), 180_000, 'unconfirmed abort prompt settlement');
    await waitFor(
      async () => {
        const row = (await controller.listSessions()).find((candidate) => candidate.id === session.id);
        return row?.status !== 'running' ? row : undefined;
      },
      180_000,
      'the run the app could not stop to finish on its own',
    );
  }

  // Close the runtime, then prove the controller re-hosts the same transcript with
  // the public lifecycle resume global.
  await deadline(rawGlobal('session.close', { sessionId: session.id }), 30_000, 'session.close')
  await waitFor(async () => (await brokerRow(session.id))?.live !== true, 15_000, 'session.close')
  await deadline(controller.resumeSession(session.id), 45_000, 'session.resume')
  const resumed = await waitFor(async () => {
    const row = await brokerRow(session.id)
    return row?.live ? row : undefined
  }, 15_000, 'session.resume')
  step(`resume re-hosted generation ${resumed.endpointGeneration ?? '?'}`)

  forked = await deadline(
    controller.forkSession({ sourceSessionId: session.id, title: 'Gajae SDK fork check' }),
    45_000,
    'session.fork',
  )
  if (forked.ownership !== 'gajae' || forked.workspace !== session.workspace) {
    throw new Error('GJC fork did not preserve desktop ownership and workspace')
  }

  await deadline(controller.deleteSession(forked.id), 45_000, 'fork close-then-delete')
  await waitForDeleted(forked.id, 'fork deletion evidence')
  step('fork closed and deleted')
  forked = undefined
  // Deleting a session whose durable state includes tool execution does not land on
  // gjc/0.18.11: `session.delete` answers `operation_failed` with
  // `outcomeCertainty: unknown` and the broker row stays `live:false, deleted:false`
  // (reproduced with a single `printf` bash turn; a session that only replied deletes
  // cleanly). The controller therefore preserves the transcript and reports it, which
  // is what this records -- after the remaining checks have run.
  const deletedId = session.id
  try {
    await deadline(controller.deleteSession(deletedId), 45_000, 'session close-then-delete')
    await waitForDeleted(deletedId, 'session deletion evidence')
    step('session closed and deleted')
    session = undefined
  } catch (error) {
    failures.push(`close-then-delete did not remove the session: ${error?.message ?? error}`)
  }
  const after = await deadline(controller.listSessions(), 30_000, 'final session list')
  if (after.some((candidate) => candidate.id === deletedId)) {
    step('session remained listed after an unconfirmed delete')
  }

  const reportPath = path.resolve(
    process.env.GJC_E2E_REPORT
      ?? path.join(tmpdir(), `gajae-gjc-sdk-e2e-${process.pid}.json`),
  )
  const report = {
    sdkSessionCli: true,
    backend: connection.backend,
    workspace,
    sessionsBefore: before.length,
    sessionsAfter: after.length,
    createdSession: deletedId,
    resumedGeneration: resumed.endpointGeneration ?? null,
    semanticSendVerified: true,
    steerVerified: true,
    terminalAbortVerified: abortConfirmed,
    resumeVerified: true,
    forkVerified: true,
    closeThenDeleteVerified: failures.every((failure) => !failure.startsWith('close-then-delete')),
    sessionRemainedListed: after.some((candidate) => candidate.id === deletedId),
    assistantText,
    ...(failures.length === 0 ? {} : { failures }),
    reportPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    throw new Error(`GJC SDK end-to-end checks failed after every step ran: ${failures.join('; ')}`);
  }
} finally {
  if (forked) {
    await deadline(controller.deleteSession(forked.id), 20_000, 'fork cleanup').catch(() => undefined)
  }
  if (session) {
    await deadline(controller.deleteSession(session.id), 20_000, 'session cleanup').catch(() => undefined)
  }
  controller.dispose()
  let mayRemoveWorkspace = temporaryWorkspace
  for (const id of [forked?.id, session?.id].filter(Boolean)) {
    const row = await deadline(brokerRow(id), 10_000, 'cleanup verification').catch(() => undefined)
    if (row && row.deleted !== true) mayRemoveWorkspace = false
  }
  if (mayRemoveWorkspace) await rm(workspace, { recursive: true, force: true })
  else if (temporaryWorkspace)
    console.error(`Preserved uncertain Gajae E2E workspace for reconciliation: ${workspace}`)
}
