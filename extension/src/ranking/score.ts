// Ranking score + ordering — PURE core, no DOM, no globals.
//
// quality_score = w1*shrunkRating + w2*priceNorm - w3*sponsoredPenalty
//               + w4*logSalesNorm + w5*freeShipping + w6*full + w7*discount
//
// `rank` computes page-level statistics across all cards (price mean/stddev,
// rating mean over present ratings, min/max sold counts), scores each, then
// sorts descending by quality score with a documented reliability tie-breaker
// (sold count desc) before the final original-index anchor, so ties preserve
// the original listing order.
//
// The sold/volume signal is `reviewCount` (the adapter fills it from
// "+N vendidos"); no PDP fetch, no manifest change. With `priorC = 0` and
// `w4 = 0` the formula reduces to the v1 one (w1*ratingNorm + w2*priceNorm
// - w3*sponsoredPenalty), preserving prior importer behavior.
//
// The functions are generic over `CardSignals` so the pure core is unit-testable
// with plain objects; in production the adapter passes `ParsedCard` (with
// nodeRef), which flows through unchanged to the scored output.

import type { CardSignals, RankConfig, PageStats } from './types';
import {
  priceNorm,
  sponsoredPenalty,
  shrunkRating,
  logSalesNorm,
  freeShippingBoost,
  fullBoost,
  discountNorm,
  computeCardPageStats,
} from './normalize';

/** Compute a single card's quality score from its signals + page stats + config. */
export function computeQualityScore(card: CardSignals, stats: PageStats, config: RankConfig): number {
  const sales = card.reviewCount ?? 0;
  return (
    config.w1 * shrunkRating(card.rating, sales, stats.ratingMean, config.priorC) +
    config.w2 * priceNorm(card.price, stats) -
    config.w3 * sponsoredPenalty(card.sponsored) +
    config.w4 * logSalesNorm(sales, stats) +
    (config.w5 ?? 0) * freeShippingBoost(card.freeShipping) +
    (config.w6 ?? 0) * fullBoost(card.full) +
    (config.w7 ?? 0) * discountNorm(card.discount)
  );
}

/**
 * Score and order cards by descending quality score.
 *
 * Tie-break order (applied only on equal score):
 *   1. reviewCount desc  (documented reliability tie-breaker; the sold count)
 *   2. originalIndex asc (stable: preserves the original listing order)
 *
 * `rank([])` -> `[]`. A single card is returned unchanged (with its score).
 * Output always carries the original input's nodeRef through (reorderer contract).
 */
export function rank<C extends CardSignals = CardSignals>(
  cards: C[],
  config: RankConfig,
): Array<C & { qualityScore: number; originalIndex: number }> {
  const stats = computeCardPageStats(cards);

  const scored = cards.map((card, originalIndex) => ({
    ...card,
    originalIndex,
    qualityScore: computeQualityScore(card, stats, config),
  }));

  scored.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    const ra = a.reviewCount ?? 0;
    const rb = b.reviewCount ?? 0;
    if (rb !== ra) return rb - ra;
    return a.originalIndex - b.originalIndex;
  });

  return scored;
}
