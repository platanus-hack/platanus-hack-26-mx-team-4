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
  reviewsFingerprint,
  CACHE_TTL_MS,
} from '../../src/detail/cache';
import type { ProxyResponse, ReviewText } from '../../src/detail/types';

const PRODUCT_ID = 'MLM123456789';
const SUMMARY: ProxyResponse = {
  strongPoints: ['Buena batería', 'Sonido claro'],
  weakPoints: ['Cable corto'],
  verdict: 'Relación calidad-precio sólida.',
};

// A stable review set + its fingerprint, used as the cache identity in every
// test below. The fingerprint is part of the cache key (Issue 6) so a changed
// review set misses the old entry.
const REVIEWS: ReviewText[] = [
  { rating: 5, text: 'Excelente batería' },
  { rating: 3, text: 'Cable corto', date: '2025-01-02' },
];
const FP = reviewsFingerprint(REVIEWS);

function clearAll(): void {
  try {
    localStorage.removeItem(cacheKey(PRODUCT_ID, FP));
  } catch {
    // ignore
  }
}

describe('summary cache — key versioning + TTL', () => {
  beforeEach(() => clearAll());
  afterEach(() => clearAll());

  it('cacheKey is versioned with the v1 prefix and includes the fingerprint', () => {
    expect(cacheKey(PRODUCT_ID, FP)).toBe('ml-summary:v1:' + PRODUCT_ID + ':' + FP);
  });

  it('CACHE_TTL_MS is exactly 7 days', () => {
    expect(CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns null when nothing is cached', () => {
    expect(readCache(PRODUCT_ID, FP)).toBeNull();
  });

  it('writes then reads back the cached summary', () => {
    writeCache(PRODUCT_ID, FP, SUMMARY);
    const entry = readCache(PRODUCT_ID, FP);
    expect(entry).not.toBeNull();
    expect(entry!.data).toEqual(SUMMARY);
    expect(entry!.ttlMs).toBe(CACHE_TTL_MS);
    expect(entry!.timestamp).toBeGreaterThan(0);
  });

  it('a fresh entry is within its TTL window', () => {
    writeCache(PRODUCT_ID, FP, SUMMARY);
    const entry = readCache(PRODUCT_ID, FP)!;
    expect(Date.now()).toBeLessThanOrEqual(entry.timestamp + entry.ttlMs);
  });

  it('clearCache removes the entry', () => {
    writeCache(PRODUCT_ID, FP, SUMMARY);
    expect(readCache(PRODUCT_ID, FP)).not.toBeNull();
    clearCache(PRODUCT_ID, FP);
    expect(readCache(PRODUCT_ID, FP)).toBeNull();
  });

  it('does not collide between products (per-product + fingerprint key)', () => {
    writeCache(PRODUCT_ID, FP, SUMMARY);
    const otherFp = reviewsFingerprint([{ rating: 5, text: 'otro' }]);
    writeCache('MLM999', otherFp, { strongPoints: ['x'], weakPoints: [], verdict: 'v' });
    expect(readCache(PRODUCT_ID, FP)!.data).toEqual(SUMMARY);
    expect(readCache('MLM999', otherFp)!.data.verdict).toBe('v');
  });
});

describe('summary cache — expiry + corruption', () => {
  beforeEach(() => clearAll());
  afterEach(() => clearAll());

  it('treats an expired entry as a miss and clears it', () => {
    writeCache(PRODUCT_ID, FP, SUMMARY);
    // Force the stored entry into the past by rewriting it with an old timestamp.
    const stale = {
      timestamp: Date.now() - CACHE_TTL_MS - 1000,
      ttlMs: CACHE_TTL_MS,
      data: SUMMARY,
    };
    localStorage.setItem(cacheKey(PRODUCT_ID, FP), JSON.stringify(stale));

    expect(readCache(PRODUCT_ID, FP)).toBeNull();
    // Expired entry was best-effort cleared.
    expect(localStorage.getItem(cacheKey(PRODUCT_ID, FP))).toBeNull();
  });

  it('treats corrupt JSON as a miss and clears it', () => {
    localStorage.setItem(cacheKey(PRODUCT_ID, FP), '{not valid json');
    expect(readCache(PRODUCT_ID, FP)).toBeNull();
    expect(localStorage.getItem(cacheKey(PRODUCT_ID, FP))).toBeNull();
  });

  it('treats a structurally-invalid payload as a miss and clears it', () => {
    // Missing weakPoints -> not a ProxyResponse.
    localStorage.setItem(
      cacheKey(PRODUCT_ID, FP),
      JSON.stringify({ timestamp: Date.now(), ttlMs: CACHE_TTL_MS, data: { strongPoints: [] } }),
    );
    expect(readCache(PRODUCT_ID, FP)).toBeNull();
  });
});

describe('summary cache — review-set fingerprint (Issue 6)', () => {
  beforeEach(() => clearAll());
  afterEach(() => clearAll());

  it('reviewsFingerprint changes when the review set changes', () => {
    const fp1 = reviewsFingerprint([{ rating: 5, text: 'Buen producto' }]);
    const fp2 = reviewsFingerprint([
      { rating: 5, text: 'Buen producto' },
      { rating: 4, text: 'Otro' },
    ]);
    expect(fp1).not.toBe(fp2);
  });

  it('reviewsFingerprint is stable for the same review set (order + text matter)', () => {
    const fp1 = reviewsFingerprint(REVIEWS);
    const fp2 = reviewsFingerprint([...REVIEWS]);
    expect(fp1).toBe(fp2);
  });

  it('reviewsFingerprint ignores empty/whitespace texts (mirrors the adapter filter)', () => {
    const fp1 = reviewsFingerprint([{ rating: 5, text: 'Bueno' }]);
    const fp2 = reviewsFingerprint([
      { rating: 5, text: 'Bueno' },
      { rating: 3, text: '   ' },
    ]);
    expect(fp1).toBe(fp2);
  });

  it('a changed review set does NOT hit the stale entry (fingerprint miss)', () => {
    const fpSmall = reviewsFingerprint([{ rating: 5, text: 'Solo una opinion' }]);
    const fpExpanded = reviewsFingerprint([
      { rating: 5, text: 'Solo una opinion' },
      { rating: 4, text: 'Segunda opinion tras expandir' },
    ]);
    expect(fpSmall).not.toBe(fpExpanded);

    // Prime the cache with the SMALL review set.
    writeCache(PRODUCT_ID, fpSmall, SUMMARY);
    // Same product, but the user expanded more reviews -> different fingerprint
    // -> MISS on the old entry (the pipeline refetches instead of serving stale).
    expect(readCache(PRODUCT_ID, fpExpanded)).toBeNull();
    // The original entry under fpSmall is still there.
    expect(readCache(PRODUCT_ID, fpSmall)?.data).toEqual(SUMMARY);
  });
});

describe('summary cache — sibling sweep on write (Round 2)', () => {
  // The suite's shared clearAll() only clears a single (PRODUCT_ID, FP) key, so
  // this block uses its own setup/teardown that wipes every ml-summary key. It
  // is placed BEFORE the storage-failure describe because withThrowingStorage
  // permanently detaches window.localStorage (it is designed to be the last
  // block in the file).
  function clearAllSummary(): void {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('ml-summary:v1:'))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      // ignore
    }
  }

  beforeEach(() => clearAllSummary());
  afterEach(() => clearAllSummary());

  it('writing a new fingerprint sweeps the old sibling entry for the same product', () => {
    const fpOld = reviewsFingerprint([{ rating: 5, text: 'unica opinion vieja' }]);
    const fpNew = reviewsFingerprint([
      { rating: 5, text: 'unica opinion vieja' },
      { rating: 4, text: 'otra opinion nueva' },
    ]);
    expect(fpOld).not.toBe(fpNew);

    writeCache(PRODUCT_ID, fpOld, SUMMARY);
    expect(readCache(PRODUCT_ID, fpOld)?.data).toEqual(SUMMARY);

    // Write under a new fingerprint -> the old sibling is swept (no orphans,
    // no unbounded growth — one live entry per product).
    writeCache(PRODUCT_ID, fpNew, { strongPoints: ['n'], weakPoints: [], verdict: 'nuevo' });
    expect(readCache(PRODUCT_ID, fpOld)).toBeNull();
    expect(readCache(PRODUCT_ID, fpNew)?.data.verdict).toBe('nuevo');
  });

  it('writeCache sweep does NOT touch other products (prefix is product-scoped)', () => {
    const fpA = reviewsFingerprint([{ rating: 5, text: 'prod A opinion' }]);
    const fpB = reviewsFingerprint([{ rating: 5, text: 'prod B opinion' }]);
    writeCache('MLM111', fpA, SUMMARY);
    writeCache('MLM222', fpB, { strongPoints: [], weakPoints: [], verdict: 'B' });

    // A new fingerprint for MLM111 must not remove MLM222's entry (the sweep
    // prefix `ml-summary:v1:MLM111:` does not match `ml-summary:v1:MLM222:`).
    writeCache('MLM111', reviewsFingerprint([{ rating: 5, text: 'prod A expandida' }]), {
      strongPoints: [],
      weakPoints: [],
      verdict: 'A2',
    });
    expect(readCache('MLM222', fpB)?.data.verdict).toBe('B');
  });

  it('writeCache sweep does not remove a different product whose id is a prefix (MLM1 vs MLM10)', () => {
    // The sweep prefix ends with ':' so `ml-summary:v1:MLM1:` must not match
    // `ml-summary:v1:MLM10:...` (no cross-product collision).
    writeCache('MLM1', reviewsFingerprint([{ rating: 5, text: 'uno' }]), SUMMARY);
    writeCache('MLM10', reviewsFingerprint([{ rating: 5, text: 'diez' }]), {
      strongPoints: [],
      weakPoints: [],
      verdict: 'diez',
    });
    writeCache('MLM1', reviewsFingerprint([{ rating: 5, text: 'uno expandido' }]), {
      strongPoints: [],
      weakPoints: [],
      verdict: 'uno2',
    });
    expect(readCache('MLM10', reviewsFingerprint([{ rating: 5, text: 'diez' }]))?.data.verdict).toBe('diez');
  });

  it('does NOT remove prior sibling entries when setItem fails (write-first, then sweep)', () => {
    // Round 3: writeCache must write FIRST and sweep AFTER. If setItem throws
    // (e.g. quota), the sweep never runs, so the prior sibling entry survives
    // instead of being deleted while the new entry never lands.
    //
    // jsdom's localStorage is a Proxy, so spyOn/defineProperty on the instance
    // don't intercept setItem. We install a Map-backed fake on `window`
    // (same technique as withThrowingStorage) whose setItem throws but whose
    // getItem/removeItem and key enumeration work, so the sweep CAN observe and
    // remove keys if it runs — proving it does NOT run after a failed write.
    const fpOld = reviewsFingerprint([{ rating: 5, text: 'opinion previa' }]);
    const fpNew = reviewsFingerprint([
      { rating: 5, text: 'opinion previa' },
      { rating: 4, text: 'opinion nueva' },
    ]);
    const oldKey = cacheKey(PRODUCT_ID, fpOld);

    const store = new Map<string, string>();
    store.set(oldKey, JSON.stringify({ timestamp: Date.now(), ttlMs: CACHE_TTL_MS, data: SUMMARY }));
    let removed = false;
    const fake = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: (k: string) => {
        removed = true;
        store.delete(k);
      },
    };
    // sweepProductKeys calls Object.keys(localStorage); expose the store keys.
    const proxy = new Proxy(fake, {
      ownKeys: () => Array.from(store.keys()),
      getOwnPropertyDescriptor: (t, p) =>
        store.has(p as string)
          ? { enumerable: true, configurable: true, value: store.get(p as string) }
          : Object.getOwnPropertyDescriptor(t, p),
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => proxy });
    try {
      expect(() =>
        writeCache(PRODUCT_ID, fpNew, { strongPoints: ['n'], weakPoints: [], verdict: 'nuevo' }),
      ).not.toThrow();
    } finally {
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }

    // The sweep never ran (setItem threw first), so the prior entry survives.
    expect(removed).toBe(false);
    expect(store.has(oldKey)).toBe(true);
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
      expect(() => readCache(PRODUCT_ID, FP)).not.toThrow();
      expect(readCache(PRODUCT_ID, FP)).toBeNull();
    });
  });

  it('writeCache swallows the storage failure (never throws)', () => {
    withThrowingStorage(() => {
      expect(() => writeCache(PRODUCT_ID, FP, SUMMARY)).not.toThrow();
    });
  });

  it('clearCache swallows the storage failure (never throws)', () => {
    withThrowingStorage(() => {
      expect(() => clearCache(PRODUCT_ID, FP)).not.toThrow();
    });
  });
});
