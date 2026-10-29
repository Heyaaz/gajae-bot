import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { OnboardingEvent } from '../shared/onboarding.js'
import type { CommandResult } from './environment-check.js'
import { OnboardingService, type OnboardingServiceOptions } from './onboarding-service.js'

interface Mac {
  gjc?: string
  models?: CommandResult
  done?: boolean
  loginScript?: string
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
    },
    applyModelPreset: async (preset) => {
      calls.push(`preset ${preset}`)
    },
    openExternal: async (url) => {
      calls.push(`open ${url}`)
    },
    spawn: () => spawn('/bin/sh', ['-c', mac.loginScript ?? 'exit 0'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  }
  return { onboarding: new OnboardingService(options), calls, isDone: () => done }
}

const listed = (stdout: string): CommandResult => ({ found: true, exitCode: 0, stdout, stderr: '' })

describe('OnboardingService', () => {
  it('starts by installing GJC on a Mac without it, then reconnects to it', async () => {
    const { onboarding, calls } = service({})
    await expect(onboarding.pendingStep()).resolves.toBe('install')
    const events: OnboardingEvent[] = []
    await expect(onboarding.installGjc((event) => events.push(event))).resolves.toEqual({ version: '0.19.2' })
    expect(events).toEqual([{ type: 'install-progress', receivedBytes: 5, totalBytes: 10 }])
    expect(calls).toEqual(['reconnect'])
    await expect(onboarding.installGjc(() => undefined)).rejects.toThrow('already installed')
  })

  it('asks for a sign-in when GJC lists no models', async () => {
    const { onboarding, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      models: listed('No models available. Set API keys in environment variables.\n'),
    })
    await expect(onboarding.pendingStep()).resolves.toBe('sign-in')
    expect(isDone()).toBe(false)
  })

  it('stays out of the way of a Mac that is already set up, and remembers it', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      models: listed('Canonical models\nclaude-opus  anthropic/claude-opus\n'),
    })
    await expect(onboarding.pendingStep()).resolves.toBeNull()
    expect(isDone()).toBe(true)
    calls.length = 0
    await expect(onboarding.pendingStep()).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it('opens the login page, then switches to the provider’s model profile once GJC saved it', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      loginScript: 'printf "Open this URL in your browser:\\nhttps://claude.ai/oauth/authorize\\n\\n"; echo "Credentials saved"',
    })
    const events: OnboardingEvent[] = []
    await onboarding.startSignIn('anthropic', (event) => events.push(event))
    expect(events).toEqual([{ type: 'open-url', url: 'https://claude.ai/oauth/authorize' }])
    expect(calls).toEqual(['open https://claude.ai/oauth/authorize', 'preset claude-opus', 'done'])
    expect(isDone()).toBe(true)
  })

  it('keeps setup open when the login fails', async () => {
    const { onboarding, calls, isDone } = service({
      gjc: '/Users/me/.local/bin/gjc',
      loginScript: 'echo "Error: Invalid API key" >&2; exit 1',
    })
    await expect(onboarding.startSignIn('zai', () => undefined)).rejects.toThrow('Invalid API key')
    expect(calls).toEqual([])
    expect(isDone()).toBe(false)
  })

  it('accepts only offered providers, one login at a time', async () => {
    const { onboarding } = service({ gjc: '/Users/me/.local/bin/gjc', loginScript: 'sleep 30' })
    await expect(onboarding.startSignIn('kiro', () => undefined)).rejects.toThrow('Unknown sign-in provider')
    const first = onboarding.startSignIn('anthropic', () => undefined)
    await expect(onboarding.startSignIn('openai-codex', () => undefined)).rejects.toThrow('already in progress')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(() => onboarding.answer('code')).not.toThrow()
    onboarding.cancelSignIn()
    await expect(first).rejects.toThrow('Sign-in cancelled')
    expect(() => onboarding.answer('code')).toThrow('No sign-in')
  })

  it('stops a login cancelled before its process started', async () => {
    const { onboarding } = service({ gjc: '/Users/me/.local/bin/gjc', loginScript: 'sleep 30' })
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
