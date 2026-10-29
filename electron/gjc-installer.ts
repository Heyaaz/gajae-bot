import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, mkdir, open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const RELEASE_REPO = 'Yeachan-Heo/gajae-code'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`
const DOWNLOAD_ORIGIN = `https://github.com/${RELEASE_REPO}/releases/download`
const CHECKSUM_ASSET = 'gajae-release-binaries.sha256'
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u

export interface GjcInstallProgress {
  receivedBytes: number
  totalBytes?: number
}

export interface GjcInstallResult {
  executable: string
  version: string
}

export interface GjcInstallerOptions {
  fetch?: typeof fetch
  arch?: string
  /** GJC's installer default (`GJC_INSTALL_DIR`, else ~/.local/bin), so `gjc update` keeps working. */
  installDirectory?: string
  readVersion?: (executable: string) => Promise<string>
}

export function releaseAssetName(arch: string): string {
  if (arch === 'arm64') return 'gjc-darwin-arm64'
  if (arch === 'x64') return 'gjc-darwin-x64'
  throw new Error(`No GJC release binary for macOS ${arch}`)
}

/** The digest `sha256sum` printed for one asset, as GJC's own installer reads it. */
export function checksumFor(text: string, assetName: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-fA-F0-9]{64}) [ *](.+)$/u.exec(line.trim())
    if (match && path.posix.basename(match[2]!.replace(/^\.\//u, '')) === assetName)
      return match[1]!.toLowerCase()
  }
  return undefined
}

function readVersionByRunning(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['--version'], { timeout: 30_000 }, (error, stdout) => {
      const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(String(stdout))?.[0]
      if (error || !version) reject(new Error(`Installed GJC did not run: ${error?.message ?? 'no version'}`))
      else resolve(version)
    })
    child.stdin?.end()
  })
}

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) throw new Error(`${what} download failed: HTTP ${response.status}`)
  return response
}

/**
 * Installs the official GJC release binary where GJC's own `install.sh` puts it.
 *
 * Only for a Mac with no GJC: an existing file at the target is never replaced
 * (updates belong to `gjc update`). The binary is checked against the release's
 * published SHA-256 before it becomes executable at the target path.
 */
export async function installGjc(
  onProgress: (progress: GjcInstallProgress) => void,
  options: GjcInstallerOptions = {},
): Promise<GjcInstallResult> {
  const fetchImpl = options.fetch ?? fetch
  const asset = releaseAssetName(options.arch ?? process.arch)
  const directory = options.installDirectory ?? process.env.GJC_INSTALL_DIR ?? path.join(homedir(), '.local/bin')
  const target = path.join(directory, 'gjc')

  const release = (await (await ok(
    await fetchImpl(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } }),
    'Release lookup',
  )).json()) as { tag_name?: unknown }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!STABLE_TAG.test(tag)) throw new Error(`Unexpected GJC release tag: ${tag || 'none'}`)

  const checksums = await (await ok(await fetchImpl(`${DOWNLOAD_ORIGIN}/${tag}/${CHECKSUM_ASSET}`), 'Checksum')).text()
  const expected = checksumFor(checksums, asset)
  if (!expected) throw new Error(`${CHECKSUM_ASSET} does not list ${asset}`)

  const response = await ok(await fetchImpl(`${DOWNLOAD_ORIGIN}/${tag}/${asset}`), 'GJC')
  if (!response.body) throw new Error('GJC download returned no body')
  const totalBytes = Number(response.headers.get('content-length')) || undefined

  await mkdir(directory, { recursive: true })
  // Same directory as the target, so the final link is on one filesystem.
  const temporary = path.join(directory, `.gjc-download-${randomUUID()}`)
  const hash = createHash('sha256')
  const file = await open(temporary, 'wx', 0o600)
  try {
    let receivedBytes = 0
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      await file.write(chunk)
      receivedBytes += chunk.byteLength
      onProgress({ receivedBytes, ...(totalBytes ? { totalBytes } : {}) })
    }
    await file.sync()
    await file.close()
    const actual = hash.digest('hex')
    if (actual !== expected) throw new Error(`GJC checksum mismatch for ${asset}`)
    await chmod(temporary, 0o755)
    // link() fails with EEXIST instead of replacing a GJC that appeared meanwhile.
    await link(temporary, target)
  } catch (error) {
    await file.close().catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`${target} already exists; use gjc update instead`)
    throw error
  } finally {
    await rm(temporary, { force: true })
  }

  const version = await (options.readVersion ?? readVersionByRunning)(target)
  return { executable: target, version }
}
