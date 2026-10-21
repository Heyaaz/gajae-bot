/**
 * A byte-bounded LRU for inline image data URLs.
 *
 * A count-only cap let 64 screenshots at the 12 MiB per-image limit hold about
 * 1 GiB of base64 in the main process. Entries are evicted oldest-first until
 * both the byte and entry budgets fit; a hit refreshes recency.
 */
export class ImageDataUrlCache {
  private readonly entries = new Map<
    string,
    { dataUrl: string; bytes: number }
  >();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxEntries = 64,
  ) {}

  get(blobId: string): string | undefined {
    const entry = this.entries.get(blobId);
    if (!entry) return undefined;
    this.entries.delete(blobId);
    this.entries.set(blobId, entry);
    return entry.dataUrl;
  }

  set(blobId: string, dataUrl: string): void {
    const previous = this.entries.get(blobId);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(blobId);
    }
    const bytes = Buffer.byteLength(dataUrl, "utf8");
    this.entries.set(blobId, { dataUrl, bytes });
    this.bytes += bytes;
    while (
      this.bytes > this.maxBytes ||
      this.entries.size > this.maxEntries
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.bytes -= evicted.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** Exposed for focused cache tests. */
  get size(): number {
    return this.entries.size;
  }

  /** Exposed for focused cache tests. */
  get byteLength(): number {
    return this.bytes;
  }
}
