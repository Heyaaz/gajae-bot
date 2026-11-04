import { SIGN_IN_PROVIDERS, type OnboardingEvent, type OnboardingStep, type SignInResult } from '../shared/onboarding.js'
import type { CommandRunner } from './environment-check.js'
import type { GjcInstallProgress, GjcInstallResult } from './gjc-installer.js'
import { GjcSignIn, type SpawnSignIn } from './gjc-sign-in.js'
import { hasNoSignedInProvider } from './provider-login.js'

export interface OnboardingServiceOptions {
  /** False for scripted smokes: nobody is setting anything up. */
  enabled: boolean
  isDone(): boolean
  markDone(): void
  locateGjc(): Promise<string | undefined>
  run: CommandRunner
  environment(): Record<string, string>
  install(onProgress: (progress: GjcInstallProgress) => void): Promise<GjcInstallResult>
  /** Points the runtime at the new GJC and reconnects. A failure here does not undo the install. */
  reconnect(): Promise<void>
  /** Saves the provider's model profile as the runtime default and reconnects; only a failed save rejects. */
  applyModelPreset(preset: string): Promise<void>
  openExternal(url: string): Promise<void>
  spawn?: SpawnSignIn
}

/**
 * First-run setup: install GJC, then sign in to one provider, all through GJC's
 * own release binary and its own login command. Done once, it stays done, so a
 * Mac already set up from the terminal never sees it.
 */
export class OnboardingService {
  private signIn: GjcSignIn | undefined
  /** Set from the call until its process exits, so a second call cannot race the first. */
  private signingIn = false
  private cancelRequested = false

  constructor(private readonly options: OnboardingServiceOptions) {}

  async pendingStep(): Promise<OnboardingStep | null> {
    if (!this.options.enabled || this.options.isDone()) return null
    const gjc = await this.options.locateGjc()
    if (!gjc) return 'install'
    if ((await hasNoSignedInProvider(this.options.run, gjc)) === true) return 'sign-in'
    // Signed in already, or a GJC this setup cannot help with; the environment
    // check in settings covers the latter.
    this.options.markDone()
    return null
  }

  /** Whether GJC is installed but has no provider to talk to. False when setup is off or GJC cannot be asked. */
  async needsSignIn(): Promise<boolean> {
    if (!this.options.enabled) return false
    const gjc = await this.options.locateGjc()
    return gjc ? (await hasNoSignedInProvider(this.options.run, gjc)) === true : false
  }

  async installGjc(emit: (event: OnboardingEvent) => void): Promise<{ version: string }> {
    if (await this.options.locateGjc()) throw new Error('GJC is already installed')
    const { version } = await this.options.install((progress) => emit({ type: 'install-progress', ...progress }))
    // GJC is installed either way. A runtime that then fails to attach shows that
    // on its own connection state, which is where the user can retry it.
    await this.options.reconnect().catch(() => undefined)
    return { version }
  }

  /**
   * Signs in to one provider. The provider's model profile becomes the default only
   * when this gives GJC its first provider; a later sign-in (another provider, or a
   * renewed token) must not change a model the user already chose.
   */
  async startSignIn(providerId: string, emit: (event: OnboardingEvent) => void): Promise<SignInResult> {
    const provider = SIGN_IN_PROVIDERS.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error('Unknown sign-in provider')
    if (this.signingIn) throw new Error('A sign-in is already in progress')
    this.signingIn = true
    let switchModel = false
    try {
      const executable = await this.options.locateGjc()
      if (!executable) throw new Error('GJC is not installed')
      if (this.cancelRequested) throw new Error('Sign-in cancelled')
      switchModel = !this.options.isDone() || (await hasNoSignedInProvider(this.options.run, executable)) !== false
      if (this.cancelRequested) throw new Error('Sign-in cancelled')
      this.signIn = new GjcSignIn({
        executable,
        provider: provider.id,
        method: provider.method,
        env: this.options.environment(),
        spawn: this.options.spawn,
        onEvent: (event) => {
          if (event.type === 'open-url') void this.options.openExternal(event.url).catch(() => undefined)
          emit(event)
        },
      })
      await this.signIn.finished
    } finally {
      this.signIn = undefined
      this.signingIn = false
      this.cancelRequested = false
    }
    if (switchModel) await this.options.applyModelPreset(provider.preset)
    this.options.markDone()
    return { switchedModel: switchModel }
  }

  answer(text: string): void {
    if (!this.signIn) throw new Error('No sign-in is waiting for an answer')
    this.signIn.answer(text)
  }

  cancelSignIn(): void {
    if (!this.signingIn) return
    this.cancelRequested = true
    this.signIn?.cancel()
  }

  dismiss(): void {
    this.cancelSignIn()
    this.options.markDone()
  }
}
