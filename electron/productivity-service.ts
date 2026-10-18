import { renameSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import type { AgentSession, TranscriptItem } from '../shared/agent-contract.js'
import type { GlobalSearchResult, LinkPreview } from '../shared/productivity-ipc.js'

/**
 * Opens the search database, rebuilding it if the file on disk is unusable.
 *
 * This index is derived data: every row is reconstructed from the transcripts on
 * demand. A corrupt file used to throw out of the constructor, and the call site
 * runs at module scope during startup, so a damaged cache took the whole app down
 * and no window opened at all. Losing the cache costs one rebuild; losing the app
 * costs the user everything.
 */
const SEARCH_SCHEMA = `CREATE TABLE IF NOT EXISTS productivity_search (
      itemId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      sessionTitle TEXT NOT NULL,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL,
      displayText TEXT NOT NULL,
      searchText TEXT NOT NULL,
      PRIMARY KEY (sessionId, itemId)
    ); CREATE INDEX IF NOT EXISTS productivity_search_session ON productivity_search(sessionId)`

function openSearchDatabase(dbPath: string): DatabaseSync {
  // `DatabaseSync` opens lazily, so a damaged file is only reported when the first
  // statement runs. Applying the schema here is what actually proves the file is
  // usable; checking only the constructor would let the failure escape later.
  try {
    const db = new DatabaseSync(dbPath)
    db.exec(SEARCH_SCHEMA)
    return db
  } catch (error) {
    // Keep the damaged file for diagnosis rather than destroying evidence, and drop
    // any previous quarantine so this cannot grow without bound.
    try {
      rmSync(`${dbPath}.corrupt`, { force: true })
      renameSync(dbPath, `${dbPath}.corrupt`)
    } catch {
      rmSync(dbPath, { force: true })
    }
    console.error(`Search index at ${dbPath} was unreadable and has been rebuilt`, error)
    const rebuilt = new DatabaseSync(dbPath)
    rebuilt.exec(SEARCH_SCHEMA)
    return rebuilt
  }
}

export interface ProductivitySource {
  listSessions(): Promise<AgentSession[]>
  getTranscript(sessionId: string): Promise<TranscriptItem[]>
}

export interface LinkResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
}

export type LinkTransport = (url: URL, address: string, signal: AbortSignal) => Promise<LinkResponse>
export type AddressResolver = (hostname: string) => Promise<string[]>

type LinkBodyIterator = AsyncIterator<Uint8Array> & Iterator<Uint8Array>

function bodyIterator(body: LinkResponse['body']): LinkBodyIterator {
  const source = body as AsyncIterable<Uint8Array> & Iterable<Uint8Array>
  return (source[Symbol.asyncIterator]?.() || source[Symbol.iterator]()) as LinkBodyIterator
}

function discardBody(body: LinkResponse['body']): void {
  const source = body as AsyncIterable<Uint8Array> & Iterable<Uint8Array> & { destroy?: () => void }
  if (typeof source.destroy === 'function') source.destroy()
  else {
    const iterator = source[Symbol.asyncIterator]?.() || source[Symbol.iterator]()
    void iterator.return?.()
  }
}

const MAX_URL = 2048
const MAX_BODY = 512 * 1024
const MAX_REDIRECTS = 5
const TIMEOUT = 8000
const MAX_CACHE = 128
const blockedAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6')

function privateAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? blockedAddresses.check(address, 'ipv4')
    : family === 6 ? blockedAddresses.check(address, 'ipv6') : true
}

function validHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return h.includes('.') && h !== 'localhost' && !h.endsWith('.localhost') && !h.endsWith('.local') && !h.endsWith('.internal') && !h.endsWith('.home.arpa') && !h.endsWith('.test') && !h.endsWith('.invalid') && !h.endsWith('.example')
}

/**
 * Decodes one numeric HTML reference. Out-of-range and surrogate values become the
 * replacement character, as browsers do, instead of throwing out of the preview.
 */
function decodeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\uFFFD'
  return String.fromCodePoint(value)
}

function metadata(html: string, url: URL): LinkPreview {
  const decode = (value: string) => value.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([0-9a-f]+));/giu, (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
    if (decimal) return decodeCodePoint(Number(decimal))
    if (hexadecimal) return decodeCodePoint(Number.parseInt(hexadecimal, 16))
    return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' } as Record<string, string>)[entity.toLowerCase()] ?? entity
  })
  const get = (re: RegExp) => decode(html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() || '')
  const meta = (name: string) => get(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i')) || get(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))
  const title = meta('og:title') || meta('twitter:title') || get(/<title[^>]*>([\s\S]*?)<\/title>/i) || url.hostname
  const description = meta('og:description') || meta('twitter:description') || meta('description')
  const siteName = meta('og:site_name') || url.hostname
  const image = meta('og:image') || meta('twitter:image')
  return image ? { url: url.toString(), title, description, siteName, image } : { url: url.toString(), title, description, siteName }
}

async function defaultTransport(url: URL, address: string, signal: AbortSignal): Promise<LinkResponse> {
  const fn = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = fn(url, { signal, headers: { 'user-agent': 'Gajae/1.0', host: url.host }, lookup: (_host, _opts, cb) => cb(null, address, isIP(address)) }, res => {
      resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: res })
    })
    req.once('error', reject)
    req.end()
  })
}

export class ProductivityService {
  private readonly cache = new Map<string, LinkPreview>()
  private readonly transport: LinkTransport
  private readonly db: DatabaseSync
  private searchStale = true
  private searchGeneration = 0
  private searchRebuild?: Promise<void>

  constructor(private readonly source: ProductivitySource, dbPath: string, options: { transport?: LinkTransport; resolver?: AddressResolver } = {}) {
    this.transport = options.transport || defaultTransport
    this.resolve = options.resolver || (async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(record => record.address))
    this.db = openSearchDatabase(dbPath)
  }
  private readonly resolve: AddressResolver

  invalidateSearch(): void { this.searchStale = true; this.searchGeneration++ }

  async previewLink(input: string): Promise<LinkPreview> {
    if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL) throw new Error('Invalid URL')
    let current: URL
    try { current = new URL(input) } catch { throw new Error('Invalid URL') }
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || !validHostname(current.hostname)) throw new Error('URL is not public')
    const cached = this.cache.get(current.toString()); if (cached) return cached
    for (let redirects = 0; ; redirects++) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT)
      let response: LinkResponse | undefined
      let completed = false
      const timedOut = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Link preview timed out')), { once: true }))
      try {
        const outcome = await Promise.race([ (async () => {
          const addresses = await this.resolve(current.hostname)
          const address = addresses.find(a => !privateAddress(a))
          if (!address || addresses.some(privateAddress)) throw new Error('URL resolves to a private address')
          response = await this.transport(current, address, controller.signal)
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects')
            const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location
            const next = new URL(location, current)
            if (next.username || next.password || !['http:', 'https:'].includes(next.protocol) || !validHostname(next.hostname)) throw new Error('Invalid redirect')
            return { redirect: next } as const
          }
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`)
          const contentTypeValue = response.headers['content-type']
          const contentType = Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue
          if (contentType && !/^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/iu.test(contentType)) throw new Error('URL did not return HTML')
          const iterator = bodyIterator(response.body)
          const chunks: Uint8Array[] = []; let size = 0
          while (true) {
            const next = await Promise.race([Promise.resolve(iterator.next()), timedOut])
            if (next.done) break
            size += next.value.byteLength
            if (size > MAX_BODY) throw new Error('Response too large')
            chunks.push(next.value)
          }
          const result = metadata(new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c)))), current)
          return { result } as const
        })(), timedOut ])
        if ('redirect' in outcome && outcome.redirect) { current = outcome.redirect; continue }
        const result = outcome.result
        this.cache.set(result.url, result); if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!)
        completed = true
        return result
      } finally {
        clearTimeout(timer)
        if (response && !completed) discardBody(response.body)
      }
    }
  }

  rebuildSearch(): Promise<void> {
    if (this.searchRebuild) return this.searchRebuild
    const generation = this.searchGeneration
    const rebuild = this.rebuildSearchIndex(generation)
    this.searchRebuild = rebuild
    void rebuild.finally(() => {
      if (this.searchRebuild === rebuild) this.searchRebuild = undefined
    }).catch(() => undefined)
    return rebuild
  }

  private async rebuildSearchIndex(generation: number): Promise<void> {
    const sessions = await this.source.listSessions()
    this.db.exec('BEGIN'); try {
      this.db.exec('DELETE FROM productivity_search')
      const insert = this.db.prepare('INSERT INTO productivity_search (itemId,sessionId,sessionTitle,workspace,kind,displayText,searchText) VALUES (?,?,?,?,?,?,?)')
      for (const session of sessions) for (const item of await this.source.getTranscript(session.id)) {
        const text = displayText(item)
        insert.run(item.id, session.id, session.title, session.workspace, item.kind, text, `${session.title} ${session.workspace} ${item.kind} ${text}`.toLocaleLowerCase())
      }
      this.db.exec('COMMIT')
      this.searchStale = this.searchGeneration !== generation
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  async searchTranscripts(query: string, limit = 50): Promise<GlobalSearchResult[]> {
    if (this.searchStale) await this.rebuildSearch(); const bounded = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 50)); const terms = (String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).slice(0, 12)
    if (!terms.length) return []
    const where = terms.map(() => 'instr(searchText, ?) > 0').join(' AND ')
    const rows = this.db.prepare(`SELECT itemId,sessionId,sessionTitle,workspace,kind,displayText FROM productivity_search WHERE ${where} ORDER BY rowid DESC LIMIT ?`).all(...terms, bounded) as Array<Record<string, string>>
    return rows.map(row => ({ sessionId: row.sessionId, itemId: row.itemId, sessionTitle: row.sessionTitle, workspace: row.workspace, kind: row.kind, displayText: row.displayText, snippet: searchSnippet(row.displayText, terms) }))
  }
}

function searchSnippet(text: string, terms: string[]): string {
  const lower = text.toLocaleLowerCase()
  const offsets = terms.map((term) => lower.indexOf(term)).filter((offset) => offset >= 0)
  const offset = offsets.length > 0 ? Math.min(...offsets) : 0
  const start = Math.max(0, offset - 70)
  const end = Math.min(text.length, offset + 170)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`
}

function displayText(item: TranscriptItem): string {
  const value = item as unknown as Record<string, unknown>
  return [value.kind, value.content, value.description, value.output, value.name, value.command, value.text].filter(v => typeof v === 'string').join(' ').slice(0, 100_000)
}
