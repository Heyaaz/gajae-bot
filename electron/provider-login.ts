import type { CommandRunner } from './environment-check.js'

// What `gjc models` prints when no provider has a credential.
const NO_MODELS = /No models available/u

/**
 * Whether GJC has no signed-in provider: true when it lists no models, false when
 * it lists some, undefined when it could not be asked. First-run setup, the
 * environment check and the sidebar all read this one answer.
 */
export async function hasNoSignedInProvider(run: CommandRunner, gjc: string): Promise<boolean | undefined> {
  const listing = await run(gjc, ['models'])
  if (!listing.found || listing.exitCode !== 0) return undefined
  return NO_MODELS.test(`${listing.stdout}\n${listing.stderr}`)
}
