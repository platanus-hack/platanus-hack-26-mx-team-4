// Per-product summary cache (Pilar 2).
//
// Stores each product's ProxyResponse in the PAGE's localStorage (content
// scripts share the page's origin storage — NO chrome.storage, so the manifest
// stays permission-free per the locked approach). Keyed + versioned:
//   `ml-summary:v1:<productId>:<fingerprint>`
// where <fingerprint> is a stable hash of the extracted review set (count + hash
// of concatenated review texts), so a CHANGED review set (more reviews expanded
// on the PDP) MISSES the old entry instead of serving a stale summary for up to
// the 7-day TTL. Freshness window: 7 days. Cache hits skip the proxy call
// entirely (spec: "Cache hits MUST avoid proxy calls").
//
// ALL storage access is wrapped in try/catch. Per the Pilar 1 jsdom
// opaque-origin discovery, localStorage access can throw on non-real-origin
// windows (opaque origin, privacy mode, quota/disabled storage). A storage
// failure MUST NEVER break the summary — it degrades to "no cache" on read and
// silently no-ops on write, so the pipeline still fetches and renders.

import type { CacheEntry, ProxyResponse, ReviewText } from './types';
import { isProxyResponse } from './parseProxyResponse';

/** Cache key prefix. Bump `v1` to invalidate every cached summary at once. */
const KEY_PREFIX = 'ml-summary:v1:';
/** Freshness window. 7 days in milliseconds. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stable, cheap fingerprint of an extracted review set: `count:hash` where
 * `hash` is a 32-bit FNV-1a of the concatenated non-empty review texts. A
 * changed review set (more reviews expanded, edited text) produces a different
 * fingerprint -> the old cache entry under the previous fingerprint is a MISS,
 * so the pipeline refetches instead of serving a stale summary for up to 7 days.
 *
 * Uses ONLY the review `text` (rating/date are not summarised on their own and
 * are not part of the cache identity). Empty/whitespace texts are excluded so a
 * DOM extraction that picks up rating-only items does not perturb the
 * fingerprint (mirrors the adapter's empty-text filter).
 */
export function reviewsFingerprint(reviews: ReviewText[]): string {
  const texts = reviews.map((r) => r.text).filter((t) => t.trim().length > 0);
  return `${texts.length}:${fnv1a(texts.join('\n'))}`;
}

/** 32-bit FNV-1a hash of a string, returned in base36 (cheap, non-crypto). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime (32-bit)
  }
  return (h >>> 0).toString(36);
}

/** Build the storage key for a product id + review fingerprint. */
export function cacheKey(productId: string, fingerprint: string): string {
  return KEY_PREFIX + productId + ':' + fingerprint;
}

/**
 * Read a fresh cached summary for `productId` + `fingerprint`, or null when
 * absent / expired / corrupt / storage-unavailable. Expired entries are
 * best-effort cleared.
 *
 * The fingerprint pins the entry to a specific review set: a changed review set
 * passes a different fingerprint and gets a MISS (no stale summary served).
 *
 * Returns the full CacheEntry (timestamp + ttl + data) so callers/tests can
 * inspect freshness; the pipeline renders `entry.data`.
 */
export function readCache(productId: string, fingerprint: string): CacheEntry | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(cacheKey(productId, fingerprint));
  } catch {
    // Opaque origin / privacy mode / disabled storage -> no cache available.
    return null;
  }
  if (!raw) return null;

  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    // Corrupt JSON (older schema, partial write) -> treat as a miss and clean up.
    safeRemove(productId, fingerprint);
    return null;
  }

  if (!isCacheEntry(entry)) {
    safeRemove(productId, fingerprint);
    return null;
  }

  // Freshness: now must be within [timestamp, timestamp + ttlMs].
  if (Date.now() > entry.timestamp + entry.ttlMs) {
    safeRemove(productId, fingerprint);
    return null;
  }
  return entry;
}

/**
 * Persist `data` for `productId` + `fingerprint` with the standard 7-day TTL.
 * Silently no-ops on any storage failure (opaque origin / quota) — the summary
 * still works for the current page view, it just won't be cached.
 *
 * Before writing, SWEEP sibling stale keys for the same product
 * (`ml-summary:v1:<productId>:*` with a different fingerprint). The
 * fingerprint-in-key scheme otherwise orphans prior entries (one entry per
 * review-count per product) and grows localStorage unbounded; sweeping keeps a
 * single live entry per product (the newest review set).
 */
export function writeCache(productId: string, fingerprint: string, data: ProxyResponse): void {
  const entry: CacheEntry = {
    timestamp: Date.now(),
    ttlMs: CACHE_TTL_MS,
    data,
  };
  const key = cacheKey(productId, fingerprint);
  try {
    // Write FIRST, then sweep siblings. If setItem throws (quota), the prior
    // sibling entry is left intact instead of being swept away while the new
    // entry never lands — otherwise a failed write would leave the product with
    // ZERO cache. The sweep runs only after a successful write.
    localStorage.setItem(key, JSON.stringify(entry));
    sweepProductKeys(productId, key);
  } catch {
    // localStorage unavailable -> degrade gracefully (no cache for this view).
  }
}

/**
 * Remove every `ml-summary:v1:<productId>:*` key except `keepKey` (the entry
 * being written). Safe when storage is unavailable or empty. The trailing `:`
 * in the prefix prevents cross-product prefix attacks (`MLM1` vs `MLM10`).
 */
function sweepProductKeys(productId: string, keepKey: string): void {
  const prefix = KEY_PREFIX + productId + ':';
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return; // storage blocked — nothing to sweep
  }
  for (const key of keys) {
    if (key !== keepKey && key.startsWith(prefix)) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore individual removal failures (best-effort sweep)
      }
    }
  }
}

/** Remove the cached summary for `productId` + `fingerprint`. Safe when absent / unavailable. */
export function clearCache(productId: string, fingerprint: string): void {
  safeRemove(productId, fingerprint);
}

/** Remove a key, swallowing any storage failure. */
function safeRemove(productId: string, fingerprint: string): void {
  try {
    localStorage.removeItem(cacheKey(productId, fingerprint));
  } catch {
    // storage blocked — nothing to remove
  }
}

/** Structural guard: a CacheEntry must carry a valid ProxyResponse payload. */
function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as CacheEntry;
  return (
    typeof e.timestamp === 'number' &&
    Number.isFinite(e.timestamp) &&
    typeof e.ttlMs === 'number' &&
    Number.isFinite(e.ttlMs) &&
    isProxyResponse(e.data)
  );
}
