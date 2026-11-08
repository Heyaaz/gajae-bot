// Real interactive CLI -> public SDK -> built renderer -> CLI, with only the
// model provider replaced. Run after building: GJC_BIN=/path/to/patched-gjc npm run gjc:cli-ask-e2e
import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
const enterOnly = process.argv.includes('--enter-only')
const project = fileURLToPath(new URL('..', import.meta.url))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const customText = 'first custom line\nsecond custom line'
const enterBase = 'STEER_FIXTURE_BASE'
const enterFollowup = 'STEER_FIXTURE_FOLLOWUP'
const scenarios = [
  { name: 'single', question: 'Choose single', expected: 'User selected: Blue' },
  { name: 'custom', question: 'Choose custom', expected: 'User provided custom input:\n  first custom line\n  second custom line' },
  { name: 'multi', question: 'Choose multi', multi: true, expected: 'User selected: Red, Blue' },
]
const providerCalls = []
const errors = []
const events = []
const terminals = []
const results = []
const fixtureTimers = new Set()
let root, workspace, agentDir, controller, cli, win, server, active

async function until(predicate, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    if (errors.length) throw new Error(`${label}: ${errors.join('; ')}`)
    last = await predicate()
    if (last) return last
    await wait(200)
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`)
}

function fixtureServer() {
  return http.createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === 'GET' && request.url === '/v1/models') {
          providerCalls.push({ kind: 'model-discovery' })
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'ask-fixture', object: 'model', created: 1, owned_by: 'fixture' }] }))
          return
        }
        assert(request.method === 'POST' && request.url === '/v1/chat/completions', `Unexpected provider request ${request.method} ${request.url}`)
        let body = ''
        for await (const chunk of request) {
          body += chunk
          assert(body.length < 4_000_000, 'Provider request exceeded size limit')
        }
        const input = JSON.parse(body)
        assert(active, 'Provider request without active scenario')
        assert(input.model === 'ask-fixture' && input.stream === true, `Unexpected provider model or streaming mode: ${JSON.stringify({ model: input.model, stream: input.stream })}`)
        if (active.name === 'enter') {
          const fixture = active
          const userMessages = input.messages.filter(message => message.role === 'user').map(message =>
            typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(''))
          const followups = userMessages.filter(text => text === enterFollowup).length
          const bases = userMessages.filter(text => text === enterBase).length
          assert(followups <= 1 && bases <= 1, `Duplicate fixture instruction in provider request: ${JSON.stringify(userMessages)}`)
          assert(followups || bases, `Unexpected Enter provider request: ${JSON.stringify(userMessages)}`)
          const call = { scenario: 'enter', kind: followups ? 'followup' : 'base', userMessages, at: Date.now() }
          providerCalls.push(call)
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: `fixture_enter_${call.kind}`, object: 'chat.completion.chunk', created: 1, model: 'ask-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
          if (followups) {
            assert(!fixture.followupReceived, 'Followup delivered to provider more than once')
            fixture.followupReceived = call
            chunk({ role: 'assistant', content: 'DONE_enter' })
            chunk({}, 'stop')
            response.end('data: [DONE]\n\n')
          } else {
            assert(!fixture.baseStarted, 'Duplicate base provider request')
            fixture.baseStarted = call.at
            fixture.baseOpen = true
            chunk({ role: 'assistant', content: 'BASE_STREAMING' })
            // Discovery runs every 15 seconds. Keep the fixture open across a
            // full discovery beat so startup is not mistaken for a lost Enter.
            const timer = setTimeout(() => {
              fixtureTimers.delete(timer)
              if (response.destroyed || response.writableEnded) return
              fixture.baseFinished = Date.now()
              chunk({}, 'stop')
              response.end('data: [DONE]\n\n')
            }, 30_000)
            fixtureTimers.add(timer)
            response.once('close', () => {
              clearTimeout(timer)
              fixtureTimers.delete(timer)
              fixture.baseOpen = false
              fixture.baseClosed = Date.now()
              fixture.baseAborted = !response.writableFinished
            })
          }
          return
        }
        const toolId = `call_${active.name}`
        const toolResults = input.messages.filter(message => message.role === 'tool' && message.tool_call_id === toolId)
        const call = { scenario: active.name, model: input.model, toolNames: input.tools?.map(tool => tool.function?.name ?? tool.name), toolResults: toolResults.map(message => message.content) }
        providerCalls.push(call)
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: `fixture_${active.name}`, object: 'chat.completion.chunk', created: 1, model: 'ask-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
        if (!toolResults.length) {
          assert(!active.toolIssued, `Duplicate initial provider call for ${active.name}`)
          assert(input.tools?.some(tool => tool.type === 'function' && tool.function?.name === 'ask'), `CLI did not offer the ask tool: ${JSON.stringify(call.toolNames)}`)
          active.toolIssued = true
          const args = { questions: [{ id: 'color', question: active.question, options: [{ label: 'Red' }, { label: 'Blue' }], ...(active.multi ? { multi: true } : {}) }] }
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: 'ask', arguments: JSON.stringify(args) } }] })
          chunk({}, 'tool_calls')
        } else {
          assert(toolResults.length === 1 && !active.toolReceived, `Unexpected repeated tool result: ${JSON.stringify(toolResults)}`)
          assert(toolResults[0].content === active.expected, `Wrong ${active.name} tool result: ${JSON.stringify(toolResults[0].content)}, expected ${JSON.stringify(active.expected)}`)
          active.toolReceived = toolResults[0].content
          chunk({ role: 'assistant', content: `DONE_${active.name}` })
          chunk({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch (error) {
        errors.push(`Provider: ${error.stack || error}`)
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
        response.end(String(error))
      }
    })()
  })
}

const render = source => win.webContents.executeJavaScript(source)
const snapshot = () => render(`({
  text: document.body.innerText,
  rows: [...document.querySelectorAll('.session-row strong')].map(row => row.textContent),
  selected: document.querySelector('.session-row.is-selected strong')?.textContent ?? null,
  cards: [...document.querySelectorAll('.question-card')].map(card => ({
    id: card.dataset.questionId, status: card.dataset.questionStatus,
    text: card.innerText, banner: !!card.closest('.question-banner'),
    options: [...card.querySelectorAll('.question-option')].map(button => ({
      label: button.querySelector('.question-option-label')?.textContent, checked: button.getAttribute('aria-checked'), disabled: button.disabled
    })),
    controls: [...card.querySelectorAll('.question-submit')].map(button => ({ label: button.textContent.trim(), disabled: button.disabled })),
    editor: !!card.querySelector('textarea')
  }))
})`)

async function selectSession(id) {
  await render("window.dispatchEvent(new Event('focus'))")
  await until(async () => (await snapshot()).rows.includes(id), `app row for ${id}`)
  await render(`(() => {
    const row = [...document.querySelectorAll('.session-row')].find(row => row.querySelector('strong')?.textContent === ${JSON.stringify(id)});
    if (!row) throw Error('CLI row disappeared');
    row.click();
  })()`)
  await until(async () => (await snapshot()).selected === id, `select CLI row ${id}`)
}

async function activeCard(id, predicate = () => true) {
  return until(async () => {
    const state = await snapshot()
    const cards = state.cards.filter(card => card.id === id && card.banner)
    assert(cards.length <= 1, `Duplicate active cards: ${JSON.stringify(state.cards)}`)
    return cards.length === 1 && predicate(cards[0]) ? { card: cards[0], state } : undefined
  }, `active app card ${id}`)
}
async function clickOption(id, label) {
  await render(`(() => {
    const card = [...document.querySelectorAll('.question-banner .question-card')].find(card => card.dataset.questionId === ${JSON.stringify(id)});
    const button = card && [...card.querySelectorAll('.question-option')].find(button => button.querySelector('.question-option-label')?.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) throw Error('Published option missing or disabled: ' + ${JSON.stringify(label)});
    button.click();
  })()`)
}
async function clickSubmit(id, label) {
  await render(`(() => {
    const card = [...document.querySelectorAll('.question-banner .question-card')].find(card => card.dataset.questionId === ${JSON.stringify(id)});
    const button = card && [...card.querySelectorAll('.question-submit')].find(button => ${label === undefined ? '!!button.closest(".question-other") && !!card.querySelector("textarea")' : `button.textContent.trim() === ${JSON.stringify(label)}`});
    if (!button || button.disabled) throw Error('Published submit control missing or disabled');
    button.click();
  })()`)
}
async function setEditor(id, text) {
  await render(`(() => {
    const card = [...document.querySelectorAll('.question-banner .question-card')].find(card => card.dataset.questionId === ${JSON.stringify(id)});
    const textarea = card?.querySelector('textarea');
    if (!textarea || textarea.disabled) throw Error('Question editor unavailable');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}

async function rows() {
  const result = JSON.parse((await execFile(executable, ['sdk', 'session', 'list', '--scope', 'all', '--json'], { cwd: workspace, timeout: 15_000 })).stdout)
  assert(result.ok === true && Array.isArray(result.result?.sessions), `Session list failed: ${JSON.stringify(result)}`)
  return result.result.sessions
}
async function pending(sessionId) {
  return cli.queryItems(sessionId, 'ask.requests.list', {})
}
async function interaction(sessionId, predicate, label) {
  return until(async () => {
    const items = await pending(sessionId)
    assert(items.length <= 1, `Unexpected pending asks: ${JSON.stringify(items)}`)
    return items[0] && predicate(items[0]) ? items[0] : undefined
  }, label)
}
async function assertSingleLogicalQuestion(sessionId, cardId) {
  const transcript = await controller.getTranscript(sessionId)
  const questions = transcript.filter(item => item.kind === 'question' && item.id === cardId)
  assert(questions.length === 1, `Expected one logical transcript question, got ${JSON.stringify(questions)}`)
}
async function startTerminal(spawnPty) {
  const terminal = spawnPty(executable, ['--model', 'gajae-fixture/ask-fixture', '--tools', 'ask', '--no-mcp', '--no-lsp', '--no-rules', '--no-title'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: workspace,
    env: { ...process.env, TERM: 'xterm-256color', GJC_AUTOMATION: '1' },
  })
  const record = { terminal, screen: '', exit: undefined, bytes: 0, chunks: 0 }
  terminals.push(record)
  terminal.onData(data => { record.bytes += Buffer.byteLength(data); record.chunks++; record.screen += data })
  terminal.onExit(event => { record.exit = event })
  const row = await until(async () => {
    if (record.exit) throw new Error(`CLI exited before ready: ${JSON.stringify(record.exit)}`)
    return (await rows()).find(item => item.live && item.pid === terminal.pid && item.endpointGeneration > 0)
  }, 'interactive CLI broker route')
  await until(() => record.screen.includes('ready'), 'interactive CLI ready status')
  return { record, row }
}

function terminalEvidence(record) {
  const stripped = record.screen.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\x1b[()][0-9A-Za-z]|\x1b[=>]/gu, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')
  return { tail: stripped.slice(-2000), totalBytes: record.bytes, dataChunks: record.chunks, retainedRawChars: record.screen.length, strippedChars: stripped.length }
}

async function runScenario(spec, spawnPty) {
  active = { ...spec }
  const { record, row } = await startTerminal(spawnPty)
  const sessionId = row.sessionId
  const capabilities = await cli.queryItems(sessionId, 'runtime.capabilities', {})
  assert(capabilities.some(item => Array.isArray(item.operations) && item.operations.includes('ask.requests.list')),
    `CLI lacks ask.requests.list; use the patched upstream CLI: ${JSON.stringify(capabilities)}`)
  await selectSession(sessionId)
  record.terminal.write(`Run the ${spec.name} fixture.\r`)
  const initial = await interaction(sessionId, item => item.interaction === 'selector', `${spec.name} public pending ask`)
  assert(initial.sessionId === sessionId && initial.question === spec.question, `Wrong pending interaction: ${JSON.stringify(initial)}`)
  assert(initial.options.includes('Red') && initial.options.includes('Blue'), `Missing color options: ${JSON.stringify(initial)}`)
  const gates = await cli.queryItems(sessionId, 'workflow.gates.list', {})
  assert(gates.length === 0, `Ordinary ask unexpectedly has workflow gates: ${JSON.stringify(gates)}`)
  const cardId = `cli-ask:${initial.questionId}`
  const before = await activeCard(cardId, card => card.options.some(option => option.label === 'Blue' && !option.disabled))
  await assertSingleLogicalQuestion(sessionId, cardId)
  const transitions = [{ public: initial, app: before.state }]

  if (spec.name === 'single') {
    await clickOption(cardId, 'Blue')
  } else if (spec.name === 'custom') {
    const other = initial.options.find(option => /^Other\b/iu.test(option))
    assert(other, `No published Other option: ${JSON.stringify(initial.options)}`)
    await clickOption(cardId, other)
    const editor = await interaction(sessionId, item => item.questionId === initial.questionId && item.interaction === 'custom_editor' && item.id !== initial.id, 'custom editor request rotation')
    const editorApp = await activeCard(cardId, card => card.editor)
    await assertSingleLogicalQuestion(sessionId, cardId)
    transitions.push({ public: editor, app: editorApp.state })
    await setEditor(cardId, customText)
    await until(async () => (await snapshot()).cards.some(card => card.id === cardId && card.banner && card.editor && card.controls.some(control => !control.disabled)), 'custom submit enabled')
    await clickSubmit(cardId)
  } else {
    let previous = initial
    for (const [index, color] of ['Red', 'Blue'].entries()) {
      await clickOption(cardId, color)
      const next = await interaction(sessionId, item => item.questionId === initial.questionId && item.id !== previous.id && item.selectedOptions?.includes(color), `${color} toggle request rotation`)
      const appState = await activeCard(cardId, card => ['Red', 'Blue'].slice(0, index + 1).every(value => card.options.some(option => option.label === value && option.checked === 'true' && !option.disabled)))
      await assertSingleLogicalQuestion(sessionId, cardId)
      transitions.push({ public: next, app: appState.state })
      previous = next
    }
    const done = previous.controls.find(control => control.id === 'navigation_forward' && control.enabled)
    assert(done, `No enabled published Done/Next: ${JSON.stringify(previous.controls)}`)
    await clickSubmit(cardId, done.label)
  }

  await until(() => active.toolReceived === spec.expected, `${spec.name} provider tool result`)
  await until(() => record.screen.includes(`DONE_${spec.name}`), `${spec.name} final marker in actual CLI`)
  const after = await until(async () => {
    const state = await snapshot()
    const question = (await controller.getTranscript(sessionId)).find(item => item.kind === 'question' && item.id === cardId)
    // Completed turns can collapse their activity cards. Check the authoritative
    // commit, the actual rendered answer and removal of the waiting banner.
    return question?.status === 'answered' && state.text.includes(`DONE_${spec.name}`) &&
      !state.cards.some(card => card.id === cardId && card.banner) ? { ...state, question } : undefined
  }, `${spec.name} committed answer and settled app view`)
  const finalPending = await pending(sessionId)
  assert(!finalPending.some(item => item.questionId === initial.questionId), `Committed question still pending: ${JSON.stringify(finalPending)}`)
  results.push({ scenario: spec.name, broker: row, capabilities, gates, transitions, after, toolResult: active.toolReceived, marker: `DONE_${spec.name}`, terminalOutput: terminalEvidence(record) })
  record.terminal.kill()
  await until(() => record.exit, `${spec.name} CLI exit`, 10_000)
}

async function runEnterScenario(spawnPty) {
  active = { name: 'enter' }
  const { record, row } = await startTerminal(spawnPty)
  const sessionId = row.sessionId
  await selectSession(sessionId)
  // A source CLI spawns several attachment/context helpers. Finish that setup
  // before opening the bounded base stream, rather than timing startup as work.
  await controller.refreshSessionContext(sessionId)
  await until(() => render(`!!document.querySelector('form.composer textarea:not(:disabled)')`), 'Enter session context and composer ready')
  record.terminal.write(`${enterBase}\r`)
  const working = await until(async () => {
    const state = await render(`({ stop: !!document.querySelector('form.composer .send-button--stop:not(:disabled)'), text: document.body.innerText })`)
    if (active.baseOpen && !active.workingProbe) {
      active.workingProbe = { at: Date.now(), app: state,
        broker: (await rows()).find(item => item.sessionId === sessionId),
        metadata: await cli.queryItems(sessionId, 'session.metadata', {}),
      }
    }
    return active.baseOpen && state.stop && state.text.includes(enterBase) ? state : undefined
  }, 'Enter provider in flight with an enabled working composer')
  await render(`(() => {
    const textarea = document.querySelector('form.composer textarea');
    if (!textarea || textarea.disabled) throw Error('Composer textarea unavailable');
    textarea.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(enterFollowup)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await until(() => render(`document.querySelector('form.composer textarea')?.value === ${JSON.stringify(enterFollowup)}`), 'followup typed in composer')
  await render(`document.querySelector('form.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))`)
  const held = await until(async () => {
    const state = await render(`({ queue: [...document.querySelectorAll('.composer-queue-text')].map(node => node.textContent), draft: document.querySelector('form.composer textarea')?.value })`)
    return state.queue.length === 1 && state.queue[0] === enterFollowup && state.draft === '' ? state : undefined
  }, 'followup held in composer queue')
  assert(active.baseOpen, 'Base stream ended before the queued Enter was inspected')
  assert(!active.followupReceived && !providerCalls.some(call => call.scenario === 'enter' && call.kind === 'followup'), 'Held followup already reached provider')
  await render(`(() => {
    window.__enterEvidence = [];
    const queuePresent = () => [...document.querySelectorAll('.composer-queue-text')].some(node => node.textContent === ${JSON.stringify(enterFollowup)});
    let previous = queuePresent();
    if (!previous) throw Error('Held followup disappeared before observation');
    window.__enterObserver = new MutationObserver(() => {
      const present = queuePresent();
      if (present !== previous) window.__enterEvidence.push({ kind: present ? 'queue-added' : 'queue-removed', at: Date.now() });
      previous = present;
    });
    window.__enterObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    const textarea = document.querySelector('form.composer textarea');
    if (!textarea || textarea.value) throw Error('Second Enter requires blank composer');
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  })()`)
  const release = await until(async () => {
    const evidence = await render('window.__enterEvidence')
    const removal = evidence.find(item => item.kind === 'queue-removed')
    const acceptance = evidence.find(item => item.kind === 'send-accepted')
    if (removal && !acceptance) throw new Error(`Queue removed before send acceptance: ${JSON.stringify(evidence)}`)
    return removal && acceptance ? evidence : undefined
  }, 'followup accepted before queue removal')
  assert(release.findIndex(item => item.kind === 'send-accepted') < release.findIndex(item => item.kind === 'queue-removed'), `Queue removal preceded acceptance: ${JSON.stringify(release)}`)
  await until(() => active.followupReceived, 'followup provider request')
  await until(() => record.screen.includes('DONE_enter'), 'Enter final marker in actual CLI')
  assert(active.baseAborted === true && !active.baseFinished, 'Blank Enter waited for natural stream completion instead of interrupting it')
  const after = await until(async () => {
    const state = await snapshot()
    const messages = (await controller.getTranscript(sessionId)).filter(item => item.kind === 'message' && item.role === 'user' && item.content === enterFollowup)
    assert(messages.length <= 1, `Duplicate transcript followup: ${JSON.stringify(messages)}`)
    return state.text.includes('DONE_enter') && messages.length === 1 ? { app: state, followupMessages: messages } : undefined
  }, 'Enter final app marker and one transcript followup')
  assert(providerCalls.filter(call => call.scenario === 'enter' && call.kind === 'followup').length === 1, 'Followup provider request was duplicated')
  await render('window.__enterObserver.disconnect()')
  results.push({ scenario: 'enter', broker: row, working, held, release, after, provider: { baseStarted: active.baseStarted, baseClosed: active.baseClosed, baseFinished: active.baseFinished, baseAborted: active.baseAborted, followup: active.followupReceived }, terminalOutput: terminalEvidence(record) })
  record.terminal.kill()
  await until(() => record.exit, 'Enter CLI exit', 10_000)
}

async function cleanup() {
  let failed = false
  if (win && !win.isDestroyed()) win.destroy()
  controller?.dispose()
  for (const record of terminals) if (!record.exit) record.terminal.kill()
  for (let i = 0; i < 100 && terminals.some(record => !record.exit); i++) await wait(100)
  if (terminals.some(record => !record.exit)) {
    console.error('Cleanup: a fixture PTY did not exit; retaining isolated root', root)
    failed = true
  }
  if (agentDir) {
    // The anchor ensures --agent-dir is this exact root, never a prefix of another path.
    const escaped = agentDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const pattern = `broker-internal --agent-dir ${escaped}$`
    let brokerRunning = false
    for (let i = 0; i < 50; i++) {
      try { execFileSync('/usr/bin/pgrep', ['-f', pattern]); brokerRunning = true } catch { brokerRunning = false; break }
      try { execFileSync('/usr/bin/pkill', ['-f', pattern]) } catch (error) { console.error('Cleanup broker signal:', error.message) }
      await wait(100)
    }
    if (brokerRunning) { console.error('Cleanup: fixture broker did not exit; retaining isolated root', root); failed = true }
  }
  if (server) {
    for (const timer of fixtureTimers) clearTimeout(timer)
    fixtureTimers.clear()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  if (root && !failed) {
    try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch (error) { console.error('Cleanup root:', error); failed = true }
  }
  return failed
}

async function run() {
  let code = 1
  let output
  try {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'gajae-cli-ask-e2e-')))
    workspace = path.join(root, 'workspace')
    agentDir = path.join(root, 'home', '.gjc', 'agent')
    // Do not pass any host credentials, provider configuration, or proxy settings.
    for (const name of Object.keys(process.env)) {
      if (!/^(PATH|TMPDIR|LANG|LC_[A-Z_]+|USER|LOGNAME|SHELL)$/u.test(name)) delete process.env[name]
    }
    process.env.HOME = path.join(root, 'home')
    process.env.XDG_CONFIG_HOME = path.join(root, 'config')
    process.env.XDG_CACHE_HOME = path.join(root, 'cache')
    process.env.GJC_CODING_AGENT_DIR = agentDir
    app.setPath('userData', path.join(root, 'user-data'))
    app.on('window-all-closed', () => {})
    await app.whenReady()
    await mkdir(workspace, { recursive: true })
    await mkdir(agentDir, { recursive: true })
    await execFile('git', ['init', '-q', workspace])
    server = fixtureServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await writeFile(path.join(agentDir, 'models.yml'), JSON.stringify({ providers: { 'gajae-fixture': {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fixture-key',
      models: [{ id: 'ask-fixture', name: 'Ask fixture', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
    } } }))
    const { GjcSdkController } = await import('../dist-electron/electron/gjc-sdk-controller.js')
    const { GjcSdkCli } = await import('../dist-electron/electron/gjc-sdk-cli.js')
    const { spawn: spawnPty } = createRequire(import.meta.url)('node-pty')
    cli = new GjcSdkCli({ executable, repo: workspace, env: { ...process.env } })
    const version = (await execFile(executable, ['--version'], { cwd: workspace, timeout: 15_000 })).stdout.trim()
    controller = new GjcSdkController({ workspace, executable, emit: event => {
      events.push(event)
      if (win && !win.isDestroyed()) win.webContents.send('cli-ask:event', event)
    } })
    ipcMain.handle('cli-ask:call', (_event, method, args) => {
      assert(typeof controller[method] === 'function', `Unknown controller method: ${method}`)
      return controller[method](...args)
    })
    ipcMain.on('cli-ask:error', (_event, message) => errors.push(`Renderer: ${message}`))
    const preload = path.join(root, 'preload.cjs')
    await writeFile(preload, `
const { ipcRenderer } = require('electron');
window.addEventListener('error', event => ipcRenderer.send('cli-ask:error', String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => ipcRenderer.send('cli-ask:error', String(event.reason)));
window.agentControlDesktop = {
  onSessionShortcut: () => () => {}, onAbortRun: () => () => {}, onCycleEffort: () => () => {},
  gjc: new Proxy({}, { get: (_target, method) => {
    if (method === 'onEvent') return listener => {
      const receive = (_event, event) => listener(event.session ? { ...event, session: { ...event.session, title: event.session.id } } : event);
      ipcRenderer.on('cli-ask:event', receive);
      return () => ipcRenderer.removeListener('cli-ask:event', receive);
    };
    if (method === 'dispose') return () => {};
    if (method === 'listSessions') return async () => (await ipcRenderer.invoke('cli-ask:call', method, [])).map(session => ({ ...session, title: session.id }));
    if (method === 'sendMessage') return async (...args) => {
      const tracked = args[1]?.text === ${JSON.stringify(enterFollowup)} && window.__enterEvidence;
      if (tracked) window.__enterEvidence.push({ kind: 'send-started', at: Date.now() });
      try {
        const result = await ipcRenderer.invoke('cli-ask:call', method, args);
        if (tracked) window.__enterEvidence.push({ kind: result === 'prompt' || result === 'steer' ? 'send-accepted' : 'send-not-accepted', at: Date.now(), result });
        return result;
      } catch (error) {
        if (tracked) window.__enterEvidence.push({ kind: 'send-failed', at: Date.now(), error: String(error) });
        throw error;
      }
    };
    return (...args) => ipcRenderer.invoke('cli-ask:call', method, args);
  } }),
};
`)
    win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(`Console: ${details.message}`) })
    win.webContents.on('preload-error', (_event, _path, error) => errors.push(`Preload: ${error.stack || error}`))
    win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${JSON.stringify(details)}`))
    await win.loadFile(path.join(project, 'dist/index.html'))
    await render("Object.defineProperty(document, 'hidden', { configurable: true, value: false }); void 0")
    for (const scenario of enterOnly ? [] : scenarios) {
      await render("window.dispatchEvent(new Event('focus'))")
      await runScenario(scenario, spawnPty)
    }
    await runEnterScenario(spawnPty)
    assert(errors.length === 0, `Fixture errors: ${errors.join('; ')}`)
    output = { passed: true, version, providerCalls, scenarios: results, errors,
      questionEvents: events.filter(event => event.type === 'question.updated') }
    code = 0
  } catch (error) {
    console.error(error.stack || error)
    let appState = null
    let brokerRows = null
    let enterEvidence = null
    try { if (win && !win.isDestroyed()) appState = await snapshot() } catch (snapshotError) { errors.push(`Snapshot: ${snapshotError}`) }
    try { if (win && !win.isDestroyed()) enterEvidence = await render('window.__enterEvidence ?? null') } catch (evidenceError) { errors.push(`Enter evidence: ${evidenceError}`) }
    try { if (workspace) brokerRows = await rows() } catch (rowError) { errors.push(`Broker snapshot: ${rowError}`) }
    console.error(JSON.stringify({ root, providerCalls, scenarios: results, brokerRows, app: appState, enterEvidence, enterFixture: active?.name === 'enter' ? active : undefined, errors,
      terminals: terminals.map(record => ({ pid: record.terminal.pid, exit: record.exit, output: record.screen })),
      questionEvents: events.filter(event => event.type === 'question.updated') }, null, 2))
  } finally {
    if (await cleanup()) code = 1
    if (code === 0) console.log(JSON.stringify(output, null, 2))
    app.exit(code)
  }
}
void run()
