import path from 'node:path'
import { GjcAcpController } from '../dist-electron/electron/gjc-acp-controller.js'

const workspace = path.resolve(process.env.AGENT_CONTROL_WORKSPACE ?? process.cwd())
const events = []
const controller = new GjcAcpController({ workspace, emit: (event) => events.push(event) })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const connection = await controller.getConnection()
  if (connection.state !== 'connected') throw new Error(`GJC did not connect: ${connection.detail}`)

  const session = await controller.createSession({
    runtime: 'gjc',
    title: 'cancel probe',
    workspace,
    isolation: 'workspace',
  })
  console.log('session:', session.id)

  let promptSettled = false
  const prompt = controller
    .sendMessage(session.id, {
      text: 'Count slowly from 1 to 400, one number per line, with no tools and no other text.',
      images: [],
      files: [],
    })
    .then(() => { promptSettled = 'resolved' })
    .catch((error) => { promptSettled = `rejected: ${error?.message ?? error}` })

  await wait(6000)
  if (process.env.SKIP_CANCEL === '1') {
    const baseline = await controller.getTranscript(session.id)
    const text = baseline.filter((i) => i.kind === 'message' && i.role === 'assistant').map((i) => i.content).join('')
    console.log('BASELINE assistant chars after 6s:', text.length)
    await wait(8000)
    const later = await controller.getTranscript(session.id)
    const laterText = later.filter((i) => i.kind === 'message' && i.role === 'assistant').map((i) => i.content).join('')
    console.log('BASELINE assistant chars after 14s:', laterText.length)
    console.log('prompt settled:', promptSettled)
    await controller.deleteSession(session.id)
    controller.dispose()
    process.exit(0)
  }
  const beforeStatus = (await controller.listSessions()).find((row) => row.id === session.id)?.status
  console.log('status before cancel:', beforeStatus)

  const startedAt = Date.now()
  let cancelOutcome = 'ok'
  try {
    await controller.cancelRun(session.id)
  } catch (error) {
    cancelOutcome = `threw: ${error?.message ?? error}`
  }
  console.log('cancelRun outcome:', cancelOutcome, `(${Date.now() - startedAt}ms)`)

  await wait(2500)
  const afterStatus = (await controller.listSessions()).find((row) => row.id === session.id)?.status
  console.log('status after cancel:', afterStatus)
  console.log('prompt settled:', promptSettled)

  const transcript = await controller.getTranscript(session.id)
  const assistantText = transcript
    .filter((item) => item.kind === 'message' && item.role === 'assistant')
    .map((item) => item.content)
    .join('')
  const notices = transcript.filter((item) => item.kind === 'notice').map((item) => item.title)
  console.log('assistant chars:', assistantText.length)
  console.log('notices:', JSON.stringify(notices))

  const lengthAtCancel = assistantText.length
  await wait(4000)
  const later = await controller.getTranscript(session.id)
  const laterText = later
    .filter((item) => item.kind === 'message' && item.role === 'assistant')
    .map((item) => item.content)
    .join('')
  console.log('assistant chars 4s later:', laterText.length)
  console.log('STILL_STREAMING:', laterText.length > lengthAtCancel)

  await prompt
  await controller.deleteSession(session.id)
} finally {
  controller.dispose()
}
