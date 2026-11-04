import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js'

// Ending a skill workflow must clear it in GJC (session.progress stops listing it),
// stop the turn parked on its question, and leave the next message to answer once
// instead of being continued by the stop gate. WITH_CONTROL=1 also runs the same
// flow without ending the workflow, to show what the gate does then.
const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
const modelPreset = process.env.AGENT_CONTROL_GJC_PRESET?.trim() || undefined
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const started = Date.now()
const log = (...args) => console.error(`+${Date.now() - started}ms`, ...args)

async function interviewUntilQuestion(label, end) {
  const workspace = await mkdtemp(path.join(tmpdir(), `gajae-workflow-end-${label}-`))
  await execFile('git', ['init', '-q', workspace], { timeout: 10_000 })
  await writeFile(path.join(workspace, 'README.txt'), 'Disposable Gajae workflow end E2E workspace.\n')
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
  let session
  try {
    session = await controller.createSession({
      runtime: 'gjc',
      title: `Workflow end probe ${label}`,
      workspace,
      isolation: 'workspace',
    })
    controller
      .sendMessage(session.id, {
        text: '/skill:deep-interview 계산기에 곱하기 기능을 추가하고 싶어요',
        images: [],
        files: [],
      })
      .catch(() => undefined)
    const workflows = async () =>
      (await controller.getGoal(session.id)).progress?.workflows.map((workflow) => workflow.skill) ?? []
    const waiting = async () =>
      (await controller.getTranscript(session.id)).some(
        (item) =>
          (item.kind === 'question' && item.status === 'pending') ||
          (item.kind === 'tool' && item.name === 'ask' && item.status === 'running'),
      )
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && !((await waiting()) && (await workflows()).includes('deep-interview'))) {
      await wait(1_000)
    }
    if (!(await workflows()).includes('deep-interview'))
      throw Object.assign(new Error('the interview never showed its workflow card'), { inconclusive: true })
    if (!(await waiting()))
      throw Object.assign(new Error('the interview never reached a pending question'), { inconclusive: true })
    log(label, 'interview waiting; workflows', await workflows())

    const failures = []
    if (end) {
      const snapshot = await controller.endWorkflow(session.id, 'deep-interview')
      const listed = snapshot.progress?.workflows.map((workflow) => workflow.skill) ?? []
      if (listed.includes('deep-interview')) failures.push(`snapshot still lists ${listed}`)
      const fresh = await workflows()
      if (fresh.includes('deep-interview')) failures.push(`GJC still lists ${fresh}`)
      const status = (await controller.listSessions()).find((row) => row.id === session.id)?.status
      if (status !== 'idle') failures.push(`window shows ${status} after the workflow ended`)
      log(label, 'workflow ended; workflows', fresh, 'status', status)
    } else {
      await controller.cancelRun(session.id)
      log(label, 'stopped without ending; workflows', await workflows())
    }

    const before = (await controller.getTranscript(session.id)).length
    await controller.sendMessage(session.id, {
      text: '인터뷰와 상관없는 질문입니다. 도구를 쓰지 말고 "안녕" 한 단어로만 답하세요.',
      images: [],
      files: [],
    })
    await wait(25_000)
    const after = (await controller.getTranscript(session.id)).slice(before)
    const replies = after.filter((item) => item.kind === 'message' && item.role === 'assistant').length
    const tools = after.filter((item) => item.kind === 'tool').map((item) => item.name)
    log(label, 'assistant messages after the unrelated prompt:', replies, 'tools', tools)
    return { replies, tools, failures }
  } finally {
    if (session) await controller.deleteSession(session.id).catch((error) => console.error(`Cleanup: ${error.message}`))
    controller.dispose()
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

try {
  const ended = await interviewUntilQuestion('ended', true)
  const failures = [...ended.failures]
  if (ended.replies !== 1) failures.push(`the stop gate continued an ended workflow: ${ended.replies} replies`)
  if (ended.tools.length > 0) failures.push(`the ended workflow still ran tools: ${ended.tools}`)
  const result = { ended: { replies: ended.replies, tools: ended.tools } }
  if (process.env.WITH_CONTROL === '1') {
    const control = await interviewUntilQuestion('control', false)
    result.control = { replies: control.replies, tools: control.tools }
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error.inconclusive ? `INCONCLUSIVE: ${error.message}` : error.stack)
  process.exitCode = error.inconclusive ? 2 : 1
}
