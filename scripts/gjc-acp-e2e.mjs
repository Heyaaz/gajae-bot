import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { GjcAcpController } from '../dist-electron/electron/gjc-acp-controller.js'

const workspace = path.resolve(process.env.AGENT_CONTROL_WORKSPACE ?? process.cwd())
const events = []
const controller = new GjcAcpController({
  workspace,
  executable: process.env.GJC_BIN,
  emit: (event) => events.push(event),
})

try {
  const connection = await controller.getConnection()
  if (connection.state !== 'connected') {
    throw new Error(`GJC did not connect: ${connection.detail}`)
  }

  const before = await controller.listSessions()
  const session = await controller.createSession({
    runtime: 'gjc',
    title: 'Agent Control connection check',
    workspace: process.cwd(),
    isolation: 'workspace',
  })
  await controller.sendMessage(
    session.id,
    { text: 'Do not use tools or modify files. Reply with exactly: GJC_CONNECTED', images: [], files: [] },
  )
  const transcript = await controller.getTranscript(session.id)
  const userText = transcript
    .filter((item) => item.kind === 'message' && item.role === 'user')
    .map((item) => item.content)
    .join('')
  const assistantMessages = transcript
    .filter((item) => item.kind === 'message' && item.role === 'assistant')
  const assistantText = assistantMessages
    .map((item) => item.content)
    .join('')
  const settledSession = events
    .filter((event) => event.type === 'session.updated' && event.session.id === session.id)
    .at(-1)?.session

  if (!userText.includes('GJC_CONNECTED')) throw new Error('GJC did not echo the ACP user message')
  if (!assistantText.includes('GJC_CONNECTED')) throw new Error(`Unexpected GJC response: ${assistantText || '<empty>'}`)
  if (assistantMessages.length !== 1) {
    throw new Error(`GJC response was split across ${assistantMessages.length} assistant messages`)
  }
  if (settledSession?.status !== 'idle') throw new Error(`GJC session did not settle idle: ${settledSession?.status}`)
  if (typeof settledSession.usagePercent !== 'number') throw new Error('GJC context usage did not reach the desktop session')

  const forked = await controller.forkSession({ sourceSessionId: session.id, title: 'Agent Control fork check' })
  if (forked.ownership !== 'gajae' || forked.attachment !== 'attached' || forked.workspace !== session.workspace) {
    throw new Error('GJC fork did not preserve the expected desktop ownership and workspace')
  }

  await controller.deleteSession(forked.id)
  await controller.deleteSession(session.id)
  const after = await controller.listSessions()
  if (after.some((candidate) => candidate.id === session.id)) {
    throw new Error('GJC test session remained after cleanup')
  }

  const report = {
    connected: true,
    backend: connection.backend,
    version: connection.version ?? null,
    workspace: connection.workspace,
    sessionsBefore: before.length,
    sessionsAfter: after.length,
    createdSession: session.id,
    forkedSession: forked.id,
    forkVerified: true,
    userMessageObserved: true,
    assistantMessageObserved: true,
    assistantMessageCount: assistantMessages.length,
    assistantText,
    finalStatus: settledSession.status,
    contextUsagePercent: settledSession.usagePercent,
    cleanedSession: true,
  }
  const artifactDirectory = path.join(workspace, 'artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(path.join(artifactDirectory, 'gjc-e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
} finally {
  controller.dispose()
}
