export const PRODUCTIVITY_IPC = {
  previewLink: 'productivity:preview-link',
  searchTranscripts: 'productivity:search-transcripts',
  rebuildSearch: 'productivity:rebuild-search',
} as const

export interface LinkPreview {
  url: string
  title: string
  description: string
  siteName: string
  image?: string
}

export interface GlobalSearchResult {
  sessionId: string
  itemId: string
  sessionTitle: string
  workspace: string
  kind: string
  displayText: string
  snippet: string
}

export interface ProductivityDesktopBridge {
  previewLink(url: string): Promise<LinkPreview>
  searchTranscripts(query: string, limit?: number): Promise<GlobalSearchResult[]>
  rebuildSearch(): Promise<void>
}
