import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProductivityService, type ProductivitySource } from './productivity-service.js'
import type { AgentSession, TranscriptItem } from '../shared/agent-contract.js'

const session = (id: string, title: string): AgentSession => ({ id, title, subtitle: '', workspace: '/workspace', runtime: 'gjc', status: 'idle', updatedAt: '', pinned: false, unread: false, accent: '', ownership: 'gajae', attachment: 'attached' })
const item = (id: string, kind: string, text: string): TranscriptItem => ({ id, kind, sessionId: 's1', content: text, role: 'user', createdAt: '' } as unknown as TranscriptItem)

function source(items: TranscriptItem[] = [item('m1', 'message', 'alpha searchable')]): ProductivitySource {
  return { listSessions: async () => [session('s1', 'First')], getTranscript: async () => items }
}

describe('ProductivityService', () => {
  it('rejects private addresses and extracts metadata with injected transport', async () => {
    const transport = async () => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: [new TextEncoder().encode('<title>Hello &amp; Gajae</title><meta name="description" content="Desc">')] })
    const service = new ProductivityService(source(), ':memory:', { resolver: async () => ['127.0.0.1'], transport })
    await expect(service.previewLink('https://example.com')).rejects.toThrow('private')
    const publicService = new ProductivityService(source(), ':memory:', { resolver: async () => ['93.184.216.34'], transport })
    await expect(publicService.previewLink('https://example.com')).resolves.toMatchObject({ title: 'Hello & Gajae', description: 'Desc', siteName: 'example.com' })
    const reservedService = new ProductivityService(source(), ':memory:', { resolver: async () => ['203.0.113.9'], transport })
    await expect(reservedService.previewLink('https://example.com')).rejects.toThrow('private')
    const mixedService = new ProductivityService(source(), ':memory:', { resolver: async () => ['93.184.216.34', '10.0.0.1'], transport })
    await expect(mixedService.previewLink('https://example.com')).rejects.toThrow('private')
    const binaryService = new ProductivityService(source(), ':memory:', { resolver: async () => ['93.184.216.34'], transport: async () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body: [] }) })
    await expect(binaryService.previewLink('https://example.com')).rejects.toThrow('HTML')
  })

  it('decodes out-of-range numeric entities without failing the preview', async () => {
    const transport = async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: [new TextEncoder().encode('<title>Valid &#99999999; &#x110000; &#65; &#x1F600;</title>')] })
    const service = new ProductivityService(source(), ':memory:', { resolver: async () => ['93.184.216.34'], transport })
    await expect(service.previewLink('https://example.com')).resolves.toMatchObject({ title: 'Valid \uFFFD \uFFFD A 😀' })
  })

  it('keeps the deadline active while a response body is stalled and closes the body', async () => {
    vi.useFakeTimers()
    const returnBody = vi.fn(async () => ({ done: true as const, value: undefined }))
    let aborted = false
    const service = new ProductivityService(source(), ':memory:', {
      resolver: async () => ['93.184.216.34'],
      transport: async (_url, _address, signal) => {
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined), return: returnBody }) },
        }
      },
    })
    try {
      const preview = service.previewLink('https://example.com')
      const rejected = expect(preview).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(8_000)
      await rejected
      expect(aborted).toBe(true)
      expect(returnBody).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('indexes kinds, rebuilds idempotently, and safely handles FTS input', async () => {
    const service = new ProductivityService(source([item('m1', 'message', 'alpha'), item('t1', 'tool', 'alpha tool')]), ':memory:')
    await service.rebuildSearch(); await service.rebuildSearch()
    const results = await service.searchTranscripts('alpha OR *', 10)
    expect(results.map(result => result.itemId).sort()).toEqual(['m1', 't1'])
    expect(results[0]).toMatchObject({ sessionId: 's1', sessionTitle: 'First', workspace: '/workspace' })
  })

  it('shares one rebuild across parallel searches', async () => {
    let releaseTranscript!: (items: TranscriptItem[]) => void
    let transcriptCalls = 0
    const items = new Promise<TranscriptItem[]>(resolve => { releaseTranscript = resolve })
    const searchSource: ProductivitySource = {
      listSessions: async () => [session('s1', 'First')],
      getTranscript: async () => { transcriptCalls++; return items },
    }
    const service = new ProductivityService(searchSource, ':memory:')

    const first = service.searchTranscripts('alpha')
    const second = service.searchTranscripts('alpha')
    await Promise.resolve()
    expect(transcriptCalls).toBe(1)
    releaseTranscript([item('m1', 'message', 'alpha searchable')])
    await expect(Promise.all([first, second])).resolves.toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.objectContaining({ itemId: 'm1' })]),
      expect.arrayContaining([expect.objectContaining({ itemId: 'm1' })]),
    ]))
  })

  it('retains invalidation that arrives while rebuilding', async () => {
    let releaseFirstTranscript!: (items: TranscriptItem[]) => void
    let transcriptCalls = 0
    let currentItems = [item('old', 'message', 'alpha old')]
    const searchSource: ProductivitySource = {
      listSessions: async () => [session('s1', 'First')],
      getTranscript: async () => {
        transcriptCalls++
        if (transcriptCalls === 1) return new Promise(resolve => { releaseFirstTranscript = resolve })
        return currentItems
      },
    }
    const service = new ProductivityService(searchSource, ':memory:')
    const firstSearch = service.searchTranscripts('alpha')
    await Promise.resolve()
    currentItems = [item('new', 'message', 'alpha new')]
    service.invalidateSearch()
    releaseFirstTranscript([item('old', 'message', 'alpha old')])
    await firstSearch

    await expect(service.searchTranscripts('alpha')).resolves.toEqual([
      expect.objectContaining({ itemId: 'new' }),
    ])
    expect(transcriptCalls).toBe(2)
  })

  it("yields the main thread while rebuilding a large index", async () => {
    const items = Array.from({ length: 1200 }, (_value, index) =>
      item(`m${index}`, "message", `alpha ${index}`),
    );
    const service = new ProductivityService(source(items), ":memory:");
    let yielded = false;
    const timer = setTimeout(() => {
      yielded = true;
    }, 0);
    await service.rebuildSearch();
    clearTimeout(timer);
    // The rebuild used to insert every row in one synchronous pass, so no timer
    // could run until it had finished.
    expect(yielded).toBe(true);
    await expect(service.searchTranscripts("alpha", 5)).resolves.toHaveLength(5);
  });

  it("reports a failed rebuild instead of serving the stale index", async () => {
    let failing = false;
    const rebuildSource: ProductivitySource = {
      listSessions: async () => [session("s1", "First")],
      getTranscript: async () => {
        if (failing) throw new Error("transcript read failed");
        return [item("m1", "message", "alpha searchable")];
      },
    };
    const service = new ProductivityService(rebuildSource, ":memory:");
    await service.rebuildSearch();
    await expect(service.searchTranscripts("alpha", 10)).resolves.toHaveLength(1);

    failing = true;
    service.invalidateSearch();
    // A stale complete index is not a successful answer to this search: the failed
    // refresh is reported, and the next search retries it.
    await expect(service.searchTranscripts("alpha", 10)).rejects.toThrow(
      "transcript read failed",
    );
    failing = false;
    await expect(service.searchTranscripts("alpha", 10)).resolves.toEqual([
      expect.objectContaining({ itemId: "m1" }),
    ]);
  });

  it("reports a first-index failure instead of resolving with no results", async () => {
    const failingSource: ProductivitySource = {
      listSessions: async () => {
        throw new Error("session list failed");
      },
      getTranscript: async () => [],
    };
    const service = new ProductivityService(failingSource, ":memory:");
    await expect(service.searchTranscripts("alpha", 10)).rejects.toThrow(
      "session list failed",
    );
  });

  it('rebuilds an unreadable index instead of taking the app down with it', async () => {
    // The search index is derived data -- every row is reconstructed from the
    // transcripts. It used to throw straight out of the constructor, which runs at
    // module scope during startup, so a damaged cache meant no window opened at all.
    // `DatabaseSync` also opens lazily, so the failure only surfaces once a
    // statement runs; applying the schema is what proves the file is usable.
    const directory = mkdtempSync(path.join(tmpdir(), 'gjc-search-index-'))
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const dbPath = path.join(directory, 'productivity.sqlite')
      writeFileSync(dbPath, 'not a database, just bytes')

      const service = new ProductivityService(source(), dbPath)
      await service.rebuildSearch()
      await expect(service.searchTranscripts('alpha', 10)).resolves.toHaveLength(1)
      // The damaged file is kept for diagnosis rather than silently destroyed.
      expect(existsSync(`${dbPath}.corrupt`)).toBe(true)
    } finally {
      warn.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps a healthy index across reopens', async () => {
    // The recovery path must not fire for a good file: quarantining on every start
    // would throw away the index each launch and rebuild it from every transcript.
    const directory = mkdtempSync(path.join(tmpdir(), 'gjc-search-keep-'))
    try {
      const dbPath = path.join(directory, 'productivity.sqlite')
      const first = new ProductivityService(source(), dbPath)
      await first.rebuildSearch()

      const second = new ProductivityService(source(), dbPath)
      await expect(second.searchTranscripts('alpha', 10)).resolves.toHaveLength(1)
      expect(existsSync(`${dbPath}.corrupt`)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
