// Cache tests — TTL hit/miss, corrupt-entry recovery, and the opaque-origin
// storage-failure fallback (Pilar 1 jsdom discovery: localStorage access can
// throw on non-real-origin windows). The global vitest jsdom is configured with
// a real ML listing URL (vitest.config.ts) so localStorage is reachable here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readCache,
  writeCache,
  clearCache,
  cacheKey,
  CACHE_TTL_MS,
} from '../../src/detail/cache';
import type { ProxyResponse } from '../../src/detail/types';

const PRODUCT_ID = 'MLM123456789';
const SUMMARY: ProxyResponse = {
  strongPoints: ['Buena batería', 'Sonido claro'],
  weakPoints: ['Cable corto'],
  verdict: 'Relación calidad-precio sólida.',
};

function clearAll(): void {
  try {
    localStorage.removeItem(cacheKey(PRODUCT_ID));
  } catch {
    // ignore
  }
}

describe('summary cache — key versioning + TTL', () => {
  beforeEach(() => clearAll());
  afterEach(() => clearAll());

  it('cacheKey is versioned with the v1 prefix', () => {
    expect(cacheKey(PRODUCT_ID)).toBe('ml-summary:v1:' + PRODUCT_ID);
  });

  it('CACHE_TTL_MS is exactly 7 days', () => {
    expect(CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns null when nothing is cached', () => {
    expect(readCache(PRODUCT_ID)).toBeNull();
  });

  it('writes then reads back the cached summary', () => {
    writeCache(PRODUCT_ID, SUMMARY);
    const entry = readCache(PRODUCT_ID);
    expect(entry).not.toBeNull();
    expect(entry!.data).toEqual(SUMMARY);
    expect(entry!.ttlMs).toBe(CACHE_TTL_MS);
    expect(entry!.timestamp).toBeGreaterThan(0);
  });

  it('a fresh entry is within its TTL window', () => {
    writeCache(PRODUCT_ID, SUMMARY);
    const entry = readCache(PRODUCT_ID)!;
    expect(Date.now()).toBeLessThanOrEqual(entry.timestamp + entry.ttlMs);
  });

  it('clearCache removes the entry', () => {
    writeCache(PRODUCT_ID, SUMMARY);
    expect(readCache(PRODUCT_ID)).not.toBeNull();
    clearCache(PRODUCT_ID);
    expect(readCache(PRODUCT_ID)).toBeNull();
  });

  it('does not collide between products (per-product key)', () => {
    writeCache(PRODUCT_ID, SUMMARY);
    writeCache('MLM999', { strongPoints: ['x'], weakPoints: [], verdict: 'v' });
    expect(readCache(PRODUCT_ID)!.data).toEqual(SUMMARY);
    expect(readCache('MLM999')!.data.verdict).toBe('v');
  });
});

describe('summary cache — expiry + corruption', () => {
  beforeEach(() => clearAll());
  afterEach(() => clearAll());

  it('treats an expired entry as a miss and clears it', () => {
    writeCache(PRODUCT_ID, SUMMARY);
    // Force the stored entry into the past by rewriting it with an old timestamp.
    const stale = {
      timestamp: Date.now() - CACHE_TTL_MS - 1000,
      ttlMs: CACHE_TTL_MS,
      data: SUMMARY,
    };
    localStorage.setItem(cacheKey(PRODUCT_ID), JSON.stringify(stale));

    expect(readCache(PRODUCT_ID)).toBeNull();
    // Expired entry was best-effort cleared.
    expect(localStorage.getItem(cacheKey(PRODUCT_ID))).toBeNull();
  });

  it('treats corrupt JSON as a miss and clears it', () => {
    localStorage.setItem(cacheKey(PRODUCT_ID), '{not valid json');
    expect(readCache(PRODUCT_ID)).toBeNull();
    expect(localStorage.getItem(cacheKey(PRODUCT_ID))).toBeNull();
  });

  it('treats a structurally-invalid payload as a miss and clears it', () => {
    // Missing weakPoints -> not a ProxyResponse.
    localStorage.setItem(
      cacheKey(PRODUCT_ID),
      JSON.stringify({ timestamp: Date.now(), ttlMs: CACHE_TTL_MS, data: { strongPoints: [] } }),
    );
    expect(readCache(PRODUCT_ID)).toBeNull();
  });
});

describe('summary cache — storage-failure fallback (opaque origin / privacy)', () => {
  // Faithful to the jsdom opaque-origin discovery: simulate a window whose
  // localStorage accessor throws and confirm the cache degrades gracefully — it
  // MUST NEVER break the pipeline, just report "no cache" / swallow writes.
  function withThrowingStorage<T>(fn: () => T): T {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new TypeError('localStorage is not available for opaque origins');
      },
      set: () => {
        throw new TypeError('localStorage is not available for opaque origins');
      },
    });
    try {
      return fn();
    } finally {
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  }

  it('readCache returns null (never throws) when localStorage access throws', () => {
    withThrowingStorage(() => {
      expect(() => readCache(PRODUCT_ID)).not.toThrow();
      expect(readCache(PRODUCT_ID)).toBeNull();
    });
  });

  it('writeCache swallows the storage failure (never throws)', () => {
    withThrowingStorage(() => {
      expect(() => writeCache(PRODUCT_ID, SUMMARY)).not.toThrow();
    });
  });

  it('clearCache swallows the storage failure (never throws)', () => {
    withThrowingStorage(() => {
      expect(() => clearCache(PRODUCT_ID)).not.toThrow();
    });
  });
});
