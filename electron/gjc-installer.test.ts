import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checksumFor, installGjc, releaseAssetName, type GjcInstallProgress } from './gjc-installer.js'

const BINARY = Buffer.from('#!/bin/sh\necho gjc/0.19.2\n')
const DIGEST = createHash('sha256').update(BINARY).digest('hex')

function release(overrides: { digest?: string; tag?: string } = {}): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: overrides.tag ?? 'v0.19.2' })
    if (url.endsWith('/gajae-release-binaries.sha256'))
      return new Response(`${overrides.digest ?? DIGEST}  gjc-darwin-arm64\n${'0'.repeat(64)}  gjc-darwin-x64\n`)
    if (url.endsWith('/gjc-darwin-arm64'))
      return new Response(BINARY, { headers: { 'content-length': String(BINARY.byteLength) } })
    return new Response('missing', { status: 404 })
  }) as typeof fetch
  return { fetch: fetchImpl, requested }
}

function installDirectory(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'gajae-gjc-install-')), 'bin')
}

describe('installGjc', () => {
  it('installs the verified release binary where GJC’s installer puts it', async () => {
    const directory = installDirectory()
    const { fetch, requested } = release()
    const progress: GjcInstallProgress[] = []
    const result = await installGjc((step) => progress.push(step), { fetch, arch: 'arm64', installDirectory: directory })

    expect(result).toEqual({ executable: path.join(directory, 'gjc'), version: '0.19.2' })
    expect(readFileSync(result.executable)).toEqual(BINARY)
    expect(statSync(result.executable).mode & 0o777).toBe(0o755)
    expect(readdirSync(directory)).toEqual(['gjc'])
    expect(progress.at(-1)).toEqual({ receivedBytes: BINARY.byteLength, totalBytes: BINARY.byteLength })
    expect(requested).toEqual([
      'https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest',
      'https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.19.2/gajae-release-binaries.sha256',
      'https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.19.2/gjc-darwin-arm64',
    ])
  })

  it('leaves nothing behind when the download does not match the published digest', async () => {
    const directory = installDirectory()
    await expect(
      installGjc(() => undefined, { fetch: release({ digest: 'f'.repeat(64) }).fetch, arch: 'arm64', installDirectory: directory }),
    ).rejects.toThrow('checksum mismatch')
    expect(readdirSync(directory)).toEqual([])
  })

  it('never replaces a GJC that is already there', async () => {
    const directory = installDirectory()
    await installGjc(() => undefined, { fetch: release().fetch, arch: 'arm64', installDirectory: directory })
    writeFileSync(path.join(directory, 'gjc'), 'the user’s own gjc')
    await expect(
      installGjc(() => undefined, { fetch: release().fetch, arch: 'arm64', installDirectory: directory }),
    ).rejects.toThrow('already exists')
    expect(readFileSync(path.join(directory, 'gjc'), 'utf8')).toBe('the user’s own gjc')
    expect(readdirSync(directory)).toEqual(['gjc'])
  })

  it('refuses a release tag that is not a stable version', async () => {
    await expect(
      installGjc(() => undefined, { fetch: release({ tag: 'v1.0.0/../x' }).fetch, arch: 'arm64', installDirectory: installDirectory() }),
    ).rejects.toThrow('Unexpected GJC release tag')
  })

  it('names the asset for each Mac architecture and reads sha256sum lines', () => {
    expect(releaseAssetName('arm64')).toBe('gjc-darwin-arm64')
    expect(releaseAssetName('x64')).toBe('gjc-darwin-x64')
    expect(() => releaseAssetName('ia32')).toThrow()
    expect(checksumFor(`${DIGEST} *./gjc-darwin-arm64\n`, 'gjc-darwin-arm64')).toBe(DIGEST)
    expect(checksumFor(`${DIGEST}  gjc-darwin-x64\n`, 'gjc-darwin-arm64')).toBeUndefined()
  })
})
