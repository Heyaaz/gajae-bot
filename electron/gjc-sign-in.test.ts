import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { GjcSignIn, SignInOutputParser, type SignInEvent } from './gjc-sign-in.js'

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

  it('fails with GJC’s own last error line, not its stack', async () => {
    const signIn = new GjcSignIn({
      executable: 'gjc',
      provider: 'zai',
      env: {},
      spawn: fakeGjc('echo "Error: Invalid API key" >&2; echo "    at login (cli.js:1:1)" >&2; exit 1'),
      onEvent: () => undefined,
    })
    await expect(signIn.finished).rejects.toThrow('Error: Invalid API key')
  })

  it('stops the login it started when cancelled', async () => {
    const signIn = new GjcSignIn({
      executable: 'gjc',
      provider: 'anthropic',
      env: {},
      spawn: fakeGjc('sleep 30'),
      onEvent: () => undefined,
    })
    signIn.cancel()
    await expect(signIn.finished).rejects.toThrow('Sign-in cancelled')
  })
})
