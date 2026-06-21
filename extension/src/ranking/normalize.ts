// Ranking normalization — pure helpers, no DOM, no globals.
// Implements the normalization defined in the spec (Requirement: Pure Quality Index):
//   ratingNorm      = clamp(rating ?? 0, 0, 5) / 5
//   priceNorm       = (mean - price) / max(stddev, EPSILON)  for present price; 0 otherwise
//   sponsoredPenalty = sponsored ? 1 : 0

import type { CardSignals, PageStats } from './types';

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
 * Null/NaN prices are ignored. Returns zeroed stats when no price is present,
 * so downstream priceNorm is always finite. Rating/sales fields are 0 here —
 * use `computeCardPageStats` to populate them from full card signals.
 */
export function computePageStats(prices: Array<number | null>): PageStats {
  const valid = prices.filter((p): p is number => p != null && !Number.isNaN(p));
  if (valid.length === 0) return { mean: 0, stddev: 0, ratingMean: 0, maxSales: 0, minSales: 0 };
  const mean = valid.reduce((sum, p) => sum + p, 0) / valid.length;
  const variance = valid.reduce((sum, p) => sum + (p - mean) ** 2, 0) / valid.length;
  return { mean, stddev: Math.sqrt(variance), ratingMean: 0, maxSales: 0, minSales: 0 };
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

/**
 * Full page statistics from card signals: price mean/stddev (same as
 * `computePageStats` over present prices) PLUS the rating mean over present
 * finite ratings and the min/max non-negative sold counts.
 *
 *   ratingMean — mean over non-null, finite ratings; 0 when none (null ratings
 *                are excluded so they neither boost a card nor skew the prior).
 *   maxSales/minSales — over non-negative sold counts (null -> 0); both 0 when
 *                the page is empty. maxSales === minSales marks a degenerate
 *                (single-card / all-equal) page for which logSalesNorm is 0.
 *
 * Used by `rank()`; kept alongside the price-only `computePageStats` so existing
 * price-stat tests and `priceNorm` stay valid unchanged.
 */
export function computeCardPageStats(cards: CardSignals[]): PageStats {
  if (cards.length === 0) {
    return { mean: 0, stddev: 0, ratingMean: 0, maxSales: 0, minSales: 0 };
  }
  const priceStats = computePageStats(cards.map((c) => c.price));

  const ratings = cards
    .map((c) => c.rating)
    .filter((r): r is number => r != null && Number.isFinite(r));
  const ratingMean = ratings.length === 0 ? 0 : ratings.reduce((sum, r) => sum + r, 0) / ratings.length;

  const sales = cards.map((c) => Math.max(0, c.reviewCount ?? 0));
  const maxSales = Math.max(...sales);
  const minSales = Math.min(...sales);

  return { ...priceStats, ratingMean, maxSales, minSales };
}

/** sponsored ? 1 : 0. */
export function sponsoredPenalty(sponsored: boolean): number {
  return sponsored ? 1 : 0;
}

/** Binary free-shipping boost: free ? 1 : 0. Undefined -> 0 (no boost). */
export function freeShippingBoost(free: boolean | undefined): number {
  return free ? 1 : 0;
}

/** Binary Mercado Envíos Full boost: full ? 1 : 0. Undefined -> 0 (no boost). */
export function fullBoost(full: boolean | undefined): number {
  return full ? 1 : 0;
}

/**
 * Clamp a real-discount fraction into 0..1. The adapter already computes
 * (previous - current) / previous; this guards against NaN / out-of-range
 * values (e.g. a corrupt "previous" price) so the term can never explode the
 * score. Undefined / non-finite -> 0.
 */
export function discountNorm(discount: number | undefined): number {
  if (discount == null || !Number.isFinite(discount)) return 0;
  return Math.min(1, Math.max(0, discount));
}

/**
 * Bayesian-shrunk rating, normalized to 0..1.
 *
 *   r = clamp(rating ?? 0, 0, 5)   (null rating short-circuits to 0)
 *   s = max(0, sales)
 *   C = max(0, priorC)
 *   rawShrunk = (C * pageRatingMean + s * r) / (C + s)   (m=page mean over PRESENT ratings)
 *   shrunkRating = rawShrunk / 5                          (spec-authoritative /5 normalization)
 *
 * Edge cases (per spec Requirement: Pure quality index v2):
 *   rating == null        -> 0  (null is excluded from the page mean upstream)
 *   sales == 0            -> rawShrunk = pageRatingMean  (shrink to the prior)
 *   C + s == 0            -> r / 5  (no shrinkage mass; falls back to ratingNorm)
 *
 * With priorC = 0 and s > 0 this reduces to r / 5 == ratingNorm, which preserves
 * the v1 scoring formula when combined with w4 = 0 (backward compatibility).
 */
export function shrunkRating(
  rating: number | null,
  sales: number,
  pageRatingMean: number,
  priorC: number,
): number {
  if (rating == null) return 0;
  const r = Math.min(5, Math.max(0, rating));
  const s = Math.max(0, sales);
  const c = Math.max(0, priorC);
  if (c + s === 0) return r / 5;
  const rawShrunk = (c * pageRatingMean + s * r) / (c + s);
  return rawShrunk / 5;
}

/**
 * Log-scaled, page-normalized sold-volume signal in 0..1.
 *
 * Spec (Requirement: Pure quality index v2):
 *   logSalesNorm = (log1p(sales) - minLog) / (maxLog - minLog)
 *   minLog = log1p(minSales), maxLog = log1p(maxSales)
 *
 * Degenerate pages return 0 for every card:
 *   maxSales <= 0           -> 0  (no sales signal; covers empty pages)
 *   maxLog === minLog        -> 0  (single card, or all sales equal)
 *   sales == page minimum    -> 0  (minLog cancels the numerator)
 *
 * The min-max form (not a plain ratio to max) is authoritative: it is the only
 * shape that yields 0 both for the page minimum and for all-equal pages, as the
 * spec requires. `minSales` is carried in `PageStats` to support it.
 */
export function logSalesNorm(sales: number, stats: PageStats): number {
  const s = Math.max(0, sales);
  const max = Math.max(0, stats.maxSales);
  const min = Math.max(0, stats.minSales);
  if (max <= 0) return 0;
  const maxLog = Math.log1p(max);
  const minLog = Math.log1p(min);
  if (maxLog === minLog) return 0;
  const norm = (Math.log1p(s) - minLog) / (maxLog - minLog);
  return Math.min(1, Math.max(0, norm));
}
