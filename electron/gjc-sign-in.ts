import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type SignInEvent =
  | { type: 'open-url'; url: string; instructions?: string }
  | { type: 'prompt'; message: string }

const OPEN_URL_HEADER = 'Open this URL in your browser:'
// readline writes a question without a newline. Text that stops at a colon and
// stays unterminated this long is GJC waiting for an answer.
const PROMPT_SETTLE_MS = 150

/**
 * Turns `gjc auth-broker login` output into the two things the app acts on: a URL
 * to open and a question to answer. Everything else it prints is narration.
 */
export class SignInOutputParser {
  private buffer = ''
  private expectingUrl = false
  private openUrl: { url: string; instructions: string[] } | undefined

  /** Events for every complete line in `chunk`. */
  push(chunk: string): SignInEvent[] {
    this.buffer += chunk
    const events: SignInEvent[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      events.push(...this.line(line))
      newline = this.buffer.indexOf('\n')
    }
    return events
  }

  /** The unterminated tail as a question, once it has stopped growing. */
  settle(): SignInEvent[] {
    const pending = this.buffer.trim()
    if (!/:$/u.test(pending)) return []
    this.buffer = ''
    // GJC appends its own colon to a message that may already end in one.
    return [...this.flushOpenUrl(), { type: 'prompt', message: pending.replace(/:+$/u, '') }]
  }

  end(): SignInEvent[] {
    return this.flushOpenUrl()
  }

  private line(line: string): SignInEvent[] {
    const text = line.trim()
    if (text === OPEN_URL_HEADER) {
      const previous = this.flushOpenUrl()
      this.expectingUrl = true
      return previous
    }
    if (this.expectingUrl) {
      if (!text) return []
      this.expectingUrl = false
      if (/^https:\/\/\S+$/u.test(text)) this.openUrl = { url: text, instructions: [] }
      return []
    }
    if (this.openUrl) {
      if (text) {
        this.openUrl.instructions.push(text)
        return []
      }
      return this.flushOpenUrl()
    }
    return []
  }

  private flushOpenUrl(): SignInEvent[] {
    const open = this.openUrl
    this.openUrl = undefined
    if (!open) return []
    const instructions = open.instructions.join('\n')
    return [{ type: 'open-url', url: open.url, ...(instructions ? { instructions } : {}) }]
  }
}

export type SpawnSignIn = (executable: string, args: string[], env: Record<string, string>) => ChildProcessWithoutNullStreams

export interface SignInOptions {
  executable: string
  provider: string
  env: Record<string, string>
  onEvent: (event: SignInEvent) => void
  spawn?: SpawnSignIn
}

/**
 * One `gjc auth-broker login <provider>` run. GJC stores the credential in its own
 * agent.db; answers go to its stdin and nothing it is given is kept or logged here.
 */
export class GjcSignIn {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly parser = new SignInOutputParser()
  private settleTimer: NodeJS.Timeout | undefined
  private cancelled = false
  readonly finished: Promise<void>

  constructor(options: SignInOptions) {
    const spawnSignIn: SpawnSignIn = options.spawn ?? ((executable, args, env) =>
      spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }))
    // stdin stays open: GJC's login asks its questions over readline and exits
    // with "readline was closed" when stdin ends.
    this.child = spawnSignIn(options.executable, ['auth-broker', 'login', options.provider], options.env)
    const emit = (events: SignInEvent[]): void => events.forEach(options.onEvent)
    let diagnostics = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      emit(this.parser.push(chunk))
      clearTimeout(this.settleTimer)
      this.settleTimer = setTimeout(() => emit(this.parser.settle()), PROMPT_SETTLE_MS)
    })
    this.child.stderr.on('data', (chunk: string) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4_000)
    })
    this.finished = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('close', (code) => {
        clearTimeout(this.settleTimer)
        emit(this.parser.end())
        if (this.cancelled) reject(new Error('Sign-in cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(lastLine(diagnostics) ?? `GJC sign-in exited with code ${code}`))
      })
    })
  }

  answer(text: string): void {
    this.child.stdin.write(`${text}\n`)
  }

  cancel(): void {
    this.cancelled = true
    this.child.kill('SIGTERM')
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('at '))
    .at(-1)
}
