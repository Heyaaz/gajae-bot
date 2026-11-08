import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { OnboardingEvent } from '../shared/onboarding.js'
import type { CommandResult } from './environment-check.js'
import {
  OnboardingService,
  type OnboardingServiceOptions,
} from './onboarding-service.js'
import {
  hasNoAvailableModels,
  readProviderAvailability,
} from './provider-login.js'

interface Mac {
  gjc?: string
  models?: CommandResult
  done?: boolean
  loginScript?: string
  reconnectError?: string
}

function service(mac: Mac) {
  const calls: string[] = []
  let done = mac.done ?? false
  let gjc = mac.gjc
  const options: OnboardingServiceOptions = {
    enabled: true,
    isDone: () => done,
    markDone: () => {
      done = true
      calls.push('done')
    },
    locateGjc: async () => gjc,
    run: async (executable, args) => {
      calls.push(`${executable} ${args.join(' ')}`)
      return mac.models ?? { found: false }
    },
    environment: () => ({}),
    install: async (onProgress) => {
      onProgress({ receivedBytes: 5, totalBytes: 10 })
      gjc = '/Users/me/.local/bin/gjc'
      return { executable: gjc, version: '0.19.2' }
    },
    reconnect: async () => {
      calls.push('reconnect')
      if (mac.reconnectError) throw new Error(mac.reconnectError)
    },
    applyModelPreset: async (preset) => {
      calls.push(`preset ${preset}`)
    },
    openExternal: async (url) => {
      calls.push(`open ${url}`)
    },
    spawn: () =>
      spawn('/bin/sh', ['-c', mac.loginScript ?? 'exit 0'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  }
  return {
    onboarding: new OnboardingService(options),
    calls,
    isDone: () => done,
  }
}

const listed = (stdout: string): CommandResult => ({
  found: true,
  exitCode: 0,
  stdout,
  stderr: '',
})
const NO_MODELS = listed(
  'No models available. Set API keys in environment variables.\n',
)
const AVAILABLE_MODELS = listed(
  'Provider models\nprovider  model       context  max-out  thinking  images\nlocal     test-model  128K     16K      -         no\n',
)

describe('provider availability', () => {
  it('reports model availability without claiming a connection kind', async () => {
    const run = async () => AVAILABLE_MODELS
    await expect(readProviderAvailability(run, 'gjc')).resolves.toEqual({
      hasAvailableModels: true,
      connectionKind: 'unknown',
    })
    await expect(hasNoAvailableModels(run, 'gjc')).resolves.toBe(false)
    await expect(
      readProviderAvailability(async () => NO_MODELS, 'gjc'),
    ).resolves.toEqual({ hasAvailableModels: false, connectionKind: 'unknown' })
    await expect(
      hasNoAvailableModels(async () => NO_MODELS, 'gjc'),
    ).resolves.toBe(true)
  })

  it('keeps failed and unrecognizable listings unknown', async () => {
    for (const result of [
      { found: false } as CommandResult,
      {
        found: true,
        exitCode: 1,
        stdout: NO_MODELS.found ? NO_MODELS.stdout : '',
        stderr: '',
      } as CommandResult,
      listed(''),
      listed('unexpected output'),
      listed(
        'Provider models\nprovider  model  context  max-out  thinking  images\n',
      ),
      listed(
        'Provider models\nprovider  model  context  max-out  thinking  images\ninvalid row\n',
      ),
    ]) {
      await expect(
        readProviderAvailability(async () => result, 'gjc'),
      ).resolves.toBeUndefined()
      await expect(
        hasNoAvailableModels(async () => result, 'gjc'),
      ).resolves.toBeUndefined()
    }
    await expect(
      readProviderAvailability(async () => {
        throw new Error('failed')
      }, 'gjc'),
    ).resolves.toBeUndefined()
  })
})

describe('OnboardingService', () => {
  it('starts by installing GJC on a Mac without it, then reconnects to it', async () => {
    const { onboarding, calls } = service({})
    await expect(onboarding.pendingStep()).resolves.toBe('install')
    const events: OnboardingEvent[] = []
    await expect(
      onboarding.installGjc((event) => events.push(event)),
    ).resolves.toEqual({ version: '0.19.2' })
    expect(events).toEqual([
      { type: 'install-progress', receivedBytes: 5, totalBytes: 10 },
    ])
    expect(calls).toEqual(['reconnect'])
    await expect(onboarding.installGjc(() => undefined)).rejects.toThrow(
      'already installed',
    )
  })

  it('reports an install that succeeded even when the runtime then fails to attach', async () => {
    const { onboarding } = service({ reconnectError: 'runtime did not attach' })
    await expect(onboarding.installGjc(() => undefined)).resolves.toEqual({
      version: '0.19.2',
    })
  })

  it('asks for a sign-in when GJC lists no models', async () => {
    const { onboarding, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      models: NO_MODELS,
    })
    await expect(onboarding.pendingStep()).resolves.toBe('sign-in')
    expect(isDone()).toBe(false)
  })

  it('stays out of the way of a Mac that is already set up, and remembers it', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      models: AVAILABLE_MODELS,
    })
    await expect(onboarding.pendingStep()).resolves.toBeNull()
    expect(isDone()).toBe(true)
    calls.length = 0
    await expect(onboarding.pendingStep()).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it('does not mark setup complete when model availability is unknown', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      models: listed('unexpected output'),
    })
    await expect(onboarding.pendingStep()).resolves.toBeNull()
    await expect(onboarding.pendingStep()).resolves.toBeNull()
    expect(isDone()).toBe(false)
    expect(calls).toEqual([
      '/Users/me/.local/bin/gjc models',
      '/Users/me/.local/bin/gjc models',
    ])
  })

  it('opens the login page, then switches to the provider’s model profile once GJC saved it', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      models: NO_MODELS,
      loginScript:
        'printf "Open this URL in your browser:\\nhttps://claude.ai/oauth/authorize\\n\\n"; echo "Credentials saved"',
    })
    const events: OnboardingEvent[] = []
    await onboarding.startSignIn('anthropic', (event) => events.push(event))
    expect(events).toEqual([
      { type: 'open-url', url: 'https://claude.ai/oauth/authorize' },
    ])
    expect(calls).toEqual([
      '/Users/me/.local/bin/gjc models',
      'open https://claude.ai/oauth/authorize',
      'preset claude-opus',
      'done',
    ])
    expect(isDone()).toBe(true)
  })

  it('says a dismissed setup still needs a sign-in while GJC has no models, and not once it has', async () => {
    const none = service({
      gjc: '/Users/me/.local/bin/gjc',
      done: true,
      models: NO_MODELS,
    })
    await expect(none.onboarding.pendingStep()).resolves.toBeNull()
    await expect(none.onboarding.needsSignIn()).resolves.toBe(true)
    const signedIn = service({
      gjc: '/Users/me/.local/bin/gjc',
      done: true,
      models: AVAILABLE_MODELS,
    })
    await expect(signedIn.onboarding.needsSignIn()).resolves.toBe(false)
    await expect(
      service({ done: true }).onboarding.needsSignIn(),
    ).resolves.toBe(false)
  })

  const LOGIN =
    'printf "Open this URL in your browser:\\nhttps://claude.ai/oauth/authorize\\n\\n"; echo "Credentials saved"'

  it('adds a provider later without changing the model the user already uses', async () => {
    const { onboarding, calls } = service({
      gjc: '/Users/me/.local/bin/gjc',
      done: true,
      models: AVAILABLE_MODELS,
      loginScript: LOGIN,
    })
    await expect(
      onboarding.startSignIn('anthropic', () => undefined),
    ).resolves.toEqual({ switchedModel: false })
    expect(calls.filter((call) => call.startsWith('preset'))).toEqual([])
  })

  it('gives a dismissed setup its provider’s model profile on the first sign-in afterwards', async () => {
    const { onboarding, calls } = service({
      gjc: '/Users/me/.local/bin/gjc',
      done: true,
      models: NO_MODELS,
      loginScript: LOGIN,
    })
    await expect(
      onboarding.startSignIn('anthropic', () => undefined),
    ).resolves.toEqual({ switchedModel: true })
    expect(calls).toContain('preset claude-opus')
  })

  it('does not change the model when the pre-login listing is unknown', async () => {
    const { onboarding, calls } = service({
      gjc: '/Users/me/.local/bin/gjc',
      loginScript: LOGIN,
    })
    await expect(
      onboarding.startSignIn('anthropic', () => undefined),
    ).resolves.toEqual({ switchedModel: false })
    expect(calls.filter((call) => call.startsWith('preset'))).toEqual([])
  })

  it('keeps setup open when the login fails', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      loginScript: [
        'echo "[Uncaught Exception] Error: Z.AI API key validation failed (401): token expired or incorrect" >&2',
        'echo "    at login (cli.js:1:1)" >&2',
        'echo "[Uncaught Exception] crash recorded at /Users/me/.gjc/agent/gjc-crash.log" >&2',
        'exit 1',
      ].join('; '),
    })
    await expect(
      onboarding.startSignIn('zai', () => undefined),
    ).rejects.toThrow('API 키가 맞지 않습니다')
    expect(calls).toEqual(['/Users/me/.local/bin/gjc models'])
    expect(isDone()).toBe(false)
  })

  it('accepts only offered providers, one login at a time', async () => {
    const { onboarding } = service({
      gjc: '/Users/me/.local/bin/gjc',
      loginScript: 'sleep 30',
    })
    await expect(
      onboarding.startSignIn('kiro', () => undefined),
    ).rejects.toThrow('Unknown sign-in provider')
    const first = onboarding.startSignIn('anthropic', () => undefined)
    await expect(
      onboarding.startSignIn('openai-codex', () => undefined),
    ).rejects.toThrow('already in progress')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => onboarding.answer('code')).not.toThrow()
    onboarding.cancelSignIn()
    await expect(first).rejects.toThrow('Sign-in cancelled')
    expect(() => onboarding.answer('code')).toThrow('No sign-in')
  })

  it('stops a login cancelled before its process started', async () => {
    const { onboarding } = service({
      gjc: '/Users/me/.local/bin/gjc',
      loginScript: 'sleep 30',
    })
    const started = onboarding.startSignIn('anthropic', () => undefined)
    onboarding.cancelSignIn()
    await expect(started).rejects.toThrow('Sign-in cancelled')
  })

  it('does nothing when disabled or dismissed', async () => {
    const dismissed = service({})
    dismissed.onboarding.dismiss()
    await expect(dismissed.onboarding.pendingStep()).resolves.toBeNull()
  })
})
