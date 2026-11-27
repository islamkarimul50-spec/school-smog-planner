interface TimedEntry<T> {
  value: T;
  expiresAtMs: number;
}

/**
 * Bounded in-memory TTL map that prunes expired entries before evicting the oldest key.
 */
export class BoundedTtlCache<T> {
  private readonly store = new Map<string, TimedEntry<T>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  public get(key: string, nowMs: number = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= nowMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public set(
    key: string,
    value: T,
    ttlMs: number,
    nowMs: number = Date.now()
  ): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.pruneExpired(nowMs);
      while (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { value, expiresAtMs: nowMs + ttlMs });
  }

  public clear(): void {
    this.store.clear();
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.store.delete(key);
      }
    }
  }
}
