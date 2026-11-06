import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { GjcSignIn, SignInOutputParser, signInFailureMessage, type SignInEvent } from './gjc-sign-in.js'

// GJC 0.19.0's `auth-broker login anthropic` output, with the URL shortened.
const ANTHROPIC_OUTPUT = [
  '',
  'Open this URL in your browser:',
  'https://claude.ai/oauth/authorize?code=true&state=abc',
  'Complete login in your browser.',
  '',
  'Waiting for browser authentication...',
  'Paste the authorization code (or full redirect URL):: ',
].join('\n')

// What `gjc auth-broker login zai` writes to stderr for a wrong key in GJC 0.19.3:
// the error, a stack, then a pointer to the crash log as the last line.
const ZAI_REJECTED_STDERR = [
  '[Uncaught Exception] Error: Z.AI API key validation failed (401): {"error":{"code":"401","message":"token expired or incorrect"}}',
  '    at validateZaiApiKey (/$bunfs/root/gjc:120:11)',
  '    at async login (/$bunfs/root/gjc:88:5)',
  '[Uncaught Exception] crash recorded at /Users/me/.gjc/agent/gjc-crash.log',
].join('\n')

describe('SignInOutputParser', () => {
  it('reads the URL to open, its instructions, and the question GJC waits on', () => {
    const parser = new SignInOutputParser()
    const events = [...parser.push(ANTHROPIC_OUTPUT), ...parser.settle()]
    expect(events).toEqual([
      {
        type: 'open-url',
        url: 'https://claude.ai/oauth/authorize?code=true&state=abc',
        instructions: 'Complete login in your browser.',
      },
      { type: 'prompt', message: 'Paste the authorization code (or full redirect URL)' },
    ])
  })

  it('opens only https URLs and asks only when the unterminated tail ends in a colon', () => {
    const parser = new SignInOutputParser()
    expect(parser.push('Open this URL in your browser:\nhttp://example.test\n\n')).toEqual([])
    expect(parser.push('Waiting for brow')).toEqual([])
    expect(parser.settle()).toEqual([])
  })
})

function fakeGjc(script: string) {
  return () => spawn('/bin/sh', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('GjcSignIn', () => {
  it('answers GJC over stdin and resolves when it saves the credential', async () => {
    const events: SignInEvent[] = []
    const signIn = new GjcSignIn({
      executable: 'gjc',
      provider: 'zai',
      method: 'api-key',
      env: {},
      spawn: fakeGjc(
        'printf "Open this URL in your browser:\\nhttps://z.ai/keys\\n\\n"; printf "Paste your Z.AI API key (sk-...):: "; read key; [ "$key" = "sk-test" ] && echo "Credentials saved"',
      ),
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'prompt') signIn.answer('sk-test')
      },
    })
    await expect(signIn.finished).resolves.toBeUndefined()
    expect(events).toEqual([
      { type: 'open-url', url: 'https://z.ai/keys' },
      { type: 'prompt', message: 'Paste your Z.AI API key (sk-...)' },
    ])
  })

  it('fails with GJC’s own error line, not its stack', async () => {
    const signIn = new GjcSignIn({
      executable: 'gjc',
      provider: 'zai',
      method: 'api-key',
      env: {},
      spawn: fakeGjc('echo "Error: Quota exceeded" >&2; echo "    at login (cli.js:1:1)" >&2; exit 1'),
      onEvent: () => undefined,
    })
    await expect(signIn.finished).rejects.toThrow(/^Quota exceeded$/u)
  })

  it('tells a wrong API key from a crash, using GJC 0.19.3’s real stderr', async () => {
    const signIn = new GjcSignIn({
      executable: 'gjc',
      provider: 'zai',
      method: 'api-key',
      env: {},
      spawn: fakeGjc(`cat >&2 <<'EOF'\n${ZAI_REJECTED_STDERR}\nEOF\nexit 1`),
      onEvent: () => undefined,
    })
    await expect(signIn.finished).rejects.toThrow('API 키가 맞지 않습니다. 키를 다시 확인해 주세요.')
  })

  it('stops the login it started when cancelled', async () => {
    const signIn = new GjcSignIn({
      executable: 'gjc',
      provider: 'anthropic',
      method: 'browser',
      env: {},
      spawn: fakeGjc('sleep 30'),
      onEvent: () => undefined,
    })
    signIn.cancel()
    await expect(signIn.finished).rejects.toThrow('Sign-in cancelled')
  })
})

describe('signInFailureMessage', () => {
  it('names the rejected key, never the crash log', () => {
    expect(signInFailureMessage(ZAI_REJECTED_STDERR, 'api-key')).toBe('API 키가 맞지 않습니다. 키를 다시 확인해 주세요.')
  })

  it('keeps the reason of a failure that is not about the key', () => {
    const stderr = '[Uncaught Exception] Error: connect ECONNREFUSED 127.0.0.1:443\n    at connect (net:1:1)\n[Uncaught Exception] crash recorded at /x/gjc-crash.log'
    expect(signInFailureMessage(stderr, 'api-key')).toBe('connect ECONNREFUSED 127.0.0.1:443')
  })

  it('does not blame an API key for an expired browser sign-in', () => {
    expect(signInFailureMessage('Error: authorization code expired', 'browser')).toBe('authorization code expired')
  })

  it('has nothing to say about empty output', () => {
    expect(signInFailureMessage('', 'api-key')).toBeUndefined()
  })
})
