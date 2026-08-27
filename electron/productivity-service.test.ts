import { describe, expect, it } from 'vitest'
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

  it('indexes kinds, rebuilds idempotently, and safely handles FTS input', async () => {
    const service = new ProductivityService(source([item('m1', 'message', 'alpha'), item('t1', 'tool', 'alpha tool')]), ':memory:')
    await service.rebuildSearch(); await service.rebuildSearch()
    const results = await service.searchTranscripts('alpha OR *', 10)
    expect(results.map(result => result.itemId).sort()).toEqual(['m1', 't1'])
    expect(results[0]).toMatchObject({ sessionId: 's1', sessionTitle: 'First', workspace: '/workspace' })
  })
})
