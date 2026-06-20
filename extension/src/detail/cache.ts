// Per-product summary cache (Pilar 2).
//
// Stores each product's ProxyResponse in the PAGE's localStorage (content
// scripts share the page's origin storage — NO chrome.storage, so the manifest
// stays permission-free per the locked approach). Keyed + versioned:
//   `ml-summary:v1:<productId>`
// with a 7-day TTL. Cache hits skip the proxy call entirely (spec: "Cache hits
// MUST avoid proxy calls").
//
// ALL storage access is wrapped in try/catch. Per the Pilar 1 jsdom
// opaque-origin discovery, localStorage access can throw on non-real-origin
// windows (opaque origin, privacy mode, quota/disabled storage). A storage
// failure MUST NEVER break the summary — it degrades to "no cache" on read and
// silently no-ops on write, so the pipeline still fetches and renders.

import type { CacheEntry, ProxyResponse } from './types';
import { isProxyResponse } from './parseProxyResponse';

/** Cache key prefix. Bump `v1` to invalidate every cached summary at once. */
const KEY_PREFIX = 'ml-summary:v1:';
/** Freshness window. 7 days in milliseconds. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Build the storage key for a product id. */
export function cacheKey(productId: string): string {
  return KEY_PREFIX + productId;
}

/**
 * Read a fresh cached summary for `productId`, or null when absent / expired /
 * corrupt / storage-unavailable. Expired entries are best-effort cleared.
 *
 * Returns the full CacheEntry (timestamp + ttl + data) so callers/tests can
 * inspect freshness; the pipeline renders `entry.data`.
 */
export function readCache(productId: string): CacheEntry | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(cacheKey(productId));
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
    safeRemove(productId);
    return null;
  }

  if (!isCacheEntry(entry)) {
    safeRemove(productId);
    return null;
  }

  // Freshness: now must be within [timestamp, timestamp + ttlMs].
  if (Date.now() > entry.timestamp + entry.ttlMs) {
    safeRemove(productId);
    return null;
  }
  return entry;
}

/**
 * Persist `data` for `productId` with the standard 7-day TTL. Silently no-ops on
 * any storage failure (opaque origin / quota) — the summary still works for the
 * current page view, it just won't be cached.
 */
export function writeCache(productId: string, data: ProxyResponse): void {
  const entry: CacheEntry = {
    timestamp: Date.now(),
    ttlMs: CACHE_TTL_MS,
    data,
  };
  try {
    localStorage.setItem(cacheKey(productId), JSON.stringify(entry));
  } catch {
    // localStorage unavailable -> degrade gracefully (no cache for this view).
  }
}

/** Remove the cached summary for `productId`. Safe when absent / unavailable. */
export function clearCache(productId: string): void {
  safeRemove(productId);
}

/** Remove a key, swallowing any storage failure. */
function safeRemove(productId: string): void {
  try {
    localStorage.removeItem(cacheKey(productId));
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
