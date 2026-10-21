import { describe, expect, it } from "vitest";
import { ImageDataUrlCache } from "./image-data-cache.js";

describe("ImageDataUrlCache", () => {
  it("evicts oldest entries until the byte budget fits", () => {
    const cache = new ImageDataUrlCache(10, 64);
    cache.set("a", "12345");
    cache.set("b", "67890");
    cache.set("c", "abcde");
    expect(cache.byteLength).toBeLessThanOrEqual(10);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("67890");
    expect(cache.get("c")).toBe("abcde");
  });

  it("refreshes recency on a hit and keeps the entry budget", () => {
    const cache = new ImageDataUrlCache(100, 2);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBe("1");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
    expect(cache.size).toBe(2);
  });

  it("replaces an existing entry without double-counting its bytes", () => {
    const cache = new ImageDataUrlCache(100, 64);
    cache.set("a", "12345");
    cache.set("a", "1");
    expect(cache.byteLength).toBe(1);
    expect(cache.get("a")).toBe("1");
  });
});
