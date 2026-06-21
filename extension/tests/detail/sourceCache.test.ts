// Per-source cache tests — the cache key namespaces external sources so each
// source caches independently and switching sources never collides or evicts
// the other source's summary. ml-internal keeps the ORIGINAL key format.

import { describe, it, expect, afterEach } from 'vitest';
import { readCache, writeCache, cacheKey } from '../../src/detail/cache';
import type { ProxyResponse } from '../../src/detail/types';

const PRODUCT_ID = 'MLM123456789';
const FP = 'ext';
const ML_SUMMARY: ProxyResponse = { strongPoints: ['ml'], weakPoints: [], verdict: 'ML.' };
const RTINGS_SUMMARY: ProxyResponse = {
  strongPoints: ['expert'],
  weakPoints: [],
  verdict: 'RTINGS.',
  sourceMeta: { sourceId: 'rtings', label: 'RTINGS', url: 'https://www.rtings.com/x', matched: true },
};

function clearAll(): void {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
}

describe('cacheKey — source namespacing', () => {
  afterEach(clearAll);

  it('keeps the original format for ml-internal (back-compat)', () => {
    expect(cacheKey(PRODUCT_ID, FP)).toBe('ml-summary:v1:' + PRODUCT_ID + ':' + FP);
    expect(cacheKey(PRODUCT_ID, FP, 'ml-internal')).toBe('ml-summary:v1:' + PRODUCT_ID + ':' + FP);
  });

  it('namespaces an external source into the key', () => {
    expect(cacheKey(PRODUCT_ID, FP, 'rtings')).toBe('ml-summary:v1:rtings:' + PRODUCT_ID + ':' + FP);
  });
});

describe('per-source cache isolation', () => {
  afterEach(clearAll);

  it('stores ml-internal and rtings summaries independently for the same product', () => {
    writeCache(PRODUCT_ID, FP, ML_SUMMARY, 'ml-internal');
    writeCache(PRODUCT_ID, FP, RTINGS_SUMMARY, 'rtings');

    expect(readCache(PRODUCT_ID, FP, 'ml-internal')!.data).toEqual(ML_SUMMARY);
    expect(readCache(PRODUCT_ID, FP, 'rtings')!.data).toEqual(RTINGS_SUMMARY);
  });

  it('a write to one source does not evict the other source (sweep is scoped)', () => {
    writeCache(PRODUCT_ID, FP, ML_SUMMARY, 'ml-internal');
    writeCache(PRODUCT_ID, 'different-fp', RTINGS_SUMMARY, 'rtings');
    // ml-internal entry survives the rtings write.
    expect(readCache(PRODUCT_ID, FP, 'ml-internal')!.data).toEqual(ML_SUMMARY);
  });

  it('round-trips sourceMeta through the cache', () => {
    writeCache(PRODUCT_ID, FP, RTINGS_SUMMARY, 'rtings');
    const back = readCache(PRODUCT_ID, FP, 'rtings')!;
    expect(back.data.sourceMeta).toEqual(RTINGS_SUMMARY.sourceMeta);
  });
});
