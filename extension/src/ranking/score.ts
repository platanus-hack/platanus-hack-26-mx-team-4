// Ranking score + ordering — PURE core, no DOM, no globals.
//
// quality_score = w1*ratingNorm + w2*priceNorm - w3*sponsoredPenalty
//
// `rank` computes page-level price statistics across all cards, scores each,
// then sorts descending by quality score with a documented reliability
// tie-breaker (reviewCount desc) before the final original-index anchor, so
// ties preserve the original listing order.
//
// The functions are generic over `CardSignals` so the pure core is unit-testable
// with plain objects; in production the adapter passes `ParsedCard` (with
// nodeRef), which flows through unchanged to the scored output.

import type { CardSignals, RankConfig, PageStats } from './types';
import { ratingNorm, priceNorm, sponsoredPenalty, computePageStats } from './normalize';

/** Compute a single card's quality score from its signals + page stats + config. */
export function computeQualityScore(card: CardSignals, stats: PageStats, config: RankConfig): number {
  return (
    config.w1 * ratingNorm(card.rating) +
    config.w2 * priceNorm(card.price, stats) -
    config.w3 * sponsoredPenalty(card.sponsored)
  );
}

/**
 * Score and order cards by descending quality score.
 *
 * Tie-break order (applied only on equal score):
 *   1. reviewCount desc  (documented reliability tie-breaker)
 *   2. originalIndex asc (stable: preserves the original listing order)
 *
 * `rank([])` -> `[]`. A single card is returned unchanged (with its score).
 * Output always carries the original input's nodeRef through (reorderer contract).
 */
export function rank<C extends CardSignals = CardSignals>(
  cards: C[],
  config: RankConfig,
): Array<C & { qualityScore: number; originalIndex: number }> {
  const stats = computePageStats(cards.map((c) => c.price));

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
