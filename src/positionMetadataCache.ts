import type { TokenInfo } from "./chain";

export interface PositionMetadataCache {
  read(
    key: string,
    load: () => Promise<{ value: TokenInfo; cacheable: boolean }>,
  ): Promise<TokenInfo>;
  clear(): void;
}

/** Display/observation metadata only. Fresh execution reads never use this cache. */
export function createPositionMetadataCache(
  options: {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {},
): PositionMetadataCache {
  const ttlMs = options.ttlMs ?? 300_000;
  const maxEntries = options.maxEntries ?? 256;
  const now = options.now ?? Date.now;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1
  )
    throw new Error("仓位元数据缓存参数无效。");
  const entries = new Map<
    string,
    { until: number; value: Promise<TokenInfo> }
  >();
  return {
    read(key, load) {
      const cached = entries.get(key);
      if (cached && now() < cached.until) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.value.then((value) => ({ ...value }));
      }
      entries.delete(key);
      const entry = {
        until: now() + ttlMs,
        value: Promise.resolve()
          .then(load)
          .then(({ value, cacheable }) => {
            if (!cacheable && entries.get(key) === entry) entries.delete(key);
            return { ...value };
          })
          .catch((error: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          }),
      };
      entries.set(key, entry);
      while (entries.size > maxEntries)
        entries.delete(entries.keys().next().value!);
      return entry.value.then((value) => ({ ...value }));
    },
    clear() {
      entries.clear();
    },
  };
}

export const positionMetadataCache = createPositionMetadataCache();
