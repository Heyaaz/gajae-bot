import type { CommandRunner } from './environment-check.js'

export interface ProviderAvailability {
  hasAvailableModels: boolean
  connectionKind: 'unknown'
}

/**
 * The sessionless model listing reports availability, not authentication or the
 * connection kind. Q29 provides the latter only for a relevant live session;
 * setup must not create a session or select an unrelated one to query it.
 */
export async function readProviderAvailability(
  run: CommandRunner,
  gjc: string,
): Promise<ProviderAvailability | undefined> {
  try {
    const listing = await run(gjc, ['models'])
    if (!listing.found || listing.exitCode !== 0) return undefined
    const lines = listing.stdout.split(/\r?\n/u)
    if (
      listing.stdout.trim() ===
      'No models available. Set API keys in environment variables.'
    ) {
      return { hasAvailableModels: false, connectionKind: 'unknown' }
    }
    const header = lines.findIndex((line) =>
      /^provider\s{2,}model\s{2,}context\s{2,}max-out\s{2,}thinking\s{2,}images\s*$/u.test(
        line,
      ),
    )
    if (header < 1 || lines[header - 1]?.trim() !== 'Provider models')
      return undefined
    const row = lines[header + 1]
    if (
      !row ||
      !/^\S.*\s{2,}\S.*\s{2,}\S+\s{2,}\S+\s{2,}\S+\s{2,}(?:yes|no)\s*$/u.test(
        row,
      )
    )
      return undefined
    return { hasAvailableModels: true, connectionKind: 'unknown' }
  } catch {
    return undefined
  }
}

export async function hasNoAvailableModels(
  run: CommandRunner,
  gjc: string,
): Promise<boolean | undefined> {
  const availability = await readProviderAvailability(run, gjc)
  return availability && !availability.hasAvailableModels
}
