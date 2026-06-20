// Ranking normalization — pure helpers, no DOM, no globals.
// Implements the normalization defined in the spec (Requirement: Pure Quality Index):
//   ratingNorm      = clamp(rating ?? 0, 0, 5) / 5
//   priceNorm       = (mean - price) / max(stddev, EPSILON)  for present price; 0 otherwise
//   sponsoredPenalty = sponsored ? 1 : 0

import type { PageStats } from './types';

/** Guards division when all prices are uniform or zero (no spread). */
const PRICE_EPSILON = 1e-6;

/** clamp(rating ?? 0, 0, 5) / 5. Null/missing rating contributes 0 (no boost). */
export function ratingNorm(rating: number | null): number {
  const r = rating ?? 0;
  const clamped = Math.min(5, Math.max(0, r));
  return clamped / 5;
}

/**
 * Page-level mean and (population) stddev over present prices only.
 * Null/NaN prices are ignored. Returns { mean: 0, stddev: 0 } when no price is
 * present, so downstream priceNorm is always finite.
 */
export function computePageStats(prices: Array<number | null>): PageStats {
  const valid = prices.filter((p): p is number => p != null && !Number.isNaN(p));
  if (valid.length === 0) return { mean: 0, stddev: 0 };
  const mean = valid.reduce((sum, p) => sum + p, 0) / valid.length;
  const variance = valid.reduce((sum, p) => sum + (p - mean) ** 2, 0) / valid.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Page z-score: (mean - price) / max(stddev, EPSILON). Cheaper-than-mean is
 * positive. Missing price -> 0. The epsilon denominator guarantees a finite
 * result even when stddev is 0 (uniform/zero prices).
 */
export function priceNorm(price: number | null, stats: PageStats): number {
  if (price == null || Number.isNaN(price)) return 0;
  const denom = Math.max(stats.stddev, PRICE_EPSILON);
  return (stats.mean - price) / denom;
}

/** sponsored ? 1 : 0. */
export function sponsoredPenalty(sponsored: boolean): number {
  return sponsored ? 1 : 0;
}
