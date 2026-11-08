// Checks the two GJC outputs first-run setup reads, against the GJC at GJC_BIN:
// `gjc models` with no credential says "No models available", and the app's own
// login runner finds the URL and the question in `auth-broker login anthropic`.
// Runs as a Mac that has never used GJC: an empty HOME and agent dir, and no
// provider keys in the environment (GJC counts those, and ~/.aws, as credentials).
// The login is cancelled at its question, so no credential is read or written.
// Needs a build (dist-electron).
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GjcSignIn } from '../dist-electron/electron/gjc-sign-in.js'
import { readProviderAvailability } from '../dist-electron/electron/provider-login.js'

const gjc = process.env.GJC_BIN
if (!gjc) throw new Error('GJC_BIN must name the GJC under test')
const root = await mkdtemp(path.join(tmpdir(), 'gajae-sign-in-contract-'))
const env = {
  PATH: '/usr/bin:/bin',
  HOME: root,
  GJC_CODING_AGENT_DIR: path.join(root, 'agent'),
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

try {
  const calls = []
  const availability = await readProviderAvailability(
    async (executable, args) => {
      calls.push(args)
      const { stdout, stderr } = await promisify(execFile)(executable, args, {
        env,
        timeout: 60_000,
      })
      return { found: true, exitCode: 0, stdout, stderr }
    },
    gjc,
  )
  assert(availability !== undefined, 'model catalog was not recognized')
  assert(
    availability.connectionKind === 'unknown',
    'model availability must not imply authentication',
  )
  assert(
    JSON.stringify(calls) === JSON.stringify([['models']]),
    'setup must not query or create a session',
  )
  console.log(
    `models: available=${availability.hasAvailableModels}; connectionKind=${availability.connectionKind}`,
  )

  const events = []
  const signIn = new GjcSignIn({
    executable: gjc,
    provider: 'anthropic',
    method: 'browser',
    env,
    onEvent: (event) => {
      events.push(event.type)
      if (event.type === 'open-url')
        assert(
          new URL(event.url).host === 'claude.ai',
          `login URL host ${new URL(event.url).host}`,
        )
      if (event.type === 'prompt') signIn.cancel()
    },
  })
  const timer = setTimeout(() => signIn.cancel(), 60_000)
  await signIn.finished.catch((error) =>
    assert(error.message === 'Sign-in cancelled', error.message),
  )
  clearTimeout(timer)
  assert(
    events.join(',') === 'open-url,prompt',
    `login events: ${events.join(',') || 'none'}`,
  )
  console.log('auth-broker login: URL to open, then the question')
} finally {
  await rm(root, { recursive: true, force: true })
}
