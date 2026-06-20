// Pure-core normalization v2 tests — strict TDD.
// Covers shrunkRating (task 1.1), logSalesNorm (1.2), computeCardPageStats (1.3).
// All helpers are pure: plain numbers in, plain numbers out, no DOM/globals.

import { describe, it, expect } from 'vitest';

import { shrunkRating, logSalesNorm, computeCardPageStats } from '../../src/ranking/normalize';
import type { CardSignals, PageStats } from '../../src/ranking/types';

describe('shrunkRating', () => {
  it('returns raw/5: with a present rating and sales=0 the raw shrinkage equals the page mean', () => {
    // sales=0, priorC=5, pageMean=4 -> raw=(5*4 + 0)/5 = 4 -> /5 = 0.8
    expect(shrunkRating(5, 0, 4, 5)).toBeCloseTo(0.8, 10);
  });

  it('shrinks a low-sales rating toward the page mean', () => {
    // rating=5, sales=1, pageMean=4, priorC=5 -> raw=(20 + 5)/6 = 25/6 -> /5
    expect(shrunkRating(5, 1, 4, 5)).toBeCloseTo((25 / 6) / 5, 10);
  });

  it('converges to the raw rating as sales dominates the prior', () => {
    // rating=5, sales=1000, pageMean=4, priorC=5 -> raw=(20+5000)/1005 = 4.995... -> /5
    expect(shrunkRating(5, 1000, 4, 5)).toBeCloseTo((5 * 4 + 1000 * 5) / 1005 / 5, 10);
  });

  it('reduces to rating/5 (ratingNorm) when priorC=0 and sales>0', () => {
    // C=0, s=10 -> raw=(0 + 10*4)/10 = 4 -> /5 = 0.8 == ratingNorm(4)
    expect(shrunkRating(4, 10, 5, 0)).toBeCloseTo(0.8, 10);
  });

  it('returns rating/5 when priorC+s=0 (no shrinkage possible)', () => {
    expect(shrunkRating(4.8, 0, 0, 0)).toBeCloseTo(0.96, 10);
  });

  it('scores a null rating as 0 (no signal = no boost)', () => {
    expect(shrunkRating(null, 100, 4.5, 5)).toBe(0);
  });

  it('clamps the rating to 0..5 before shrinking', () => {
    // rating=7 -> r=5; sales=100, pageMean=4, priorC=5 -> raw=(20+500)/105 -> /5
    expect(shrunkRating(7, 100, 4, 5)).toBeCloseTo((5 * 4 + 100 * 5) / 105 / 5, 10);
  });

  it('keeps a rated card strictly above an unrated card (rated>unrated invariant)', () => {
    const rated = shrunkRating(3, 5, 4, 5);
    const unrated = shrunkRating(null, 5, 4, 5);
    expect(rated).toBeGreaterThan(unrated);
    expect(unrated).toBe(0);
  });
});

describe('logSalesNorm', () => {
  /** Minimal page-stats literal carrying only the sales signal under test. */
  const salesStats = (maxSales: number, minSales = 0): PageStats => ({
    mean: 0,
    stddev: 0,
    ratingMean: 0,
    maxSales,
    minSales,
  });

  it('is 0 when the page has no sales signal (maxSales <= 0)', () => {
    expect(logSalesNorm(0, salesStats(0))).toBe(0);
    expect(logSalesNorm(50, salesStats(0))).toBe(0);
  });

  it('is 0 for every card when all sales are equal (max === min)', () => {
    expect(logSalesNorm(100, salesStats(100, 100))).toBe(0);
  });

  it('is 0 for a single-card page (max === min)', () => {
    expect(logSalesNorm(100, salesStats(100, 100))).toBe(0);
  });

  it('scores sales=0 as 0 when 0 is the page minimum', () => {
    expect(logSalesNorm(0, salesStats(100, 0))).toBe(0);
  });

  it('scores the max-sales card as 1 when the page minimum is 0', () => {
    expect(logSalesNorm(100, salesStats(100, 0))).toBeCloseTo(1, 10);
  });

  it('min-max normalizes a mid sales value between min=0 and max', () => {
    // log1p(100) / log1p(1000)
    expect(logSalesNorm(100, salesStats(1000, 0))).toBeCloseTo(
      Math.log1p(100) / Math.log1p(1000),
      10,
    );
  });

  it('shifts by the page min log when min > 0 (spec min-max, not ratio-to-max)', () => {
    // (log1p(100) - log1p(10)) / (log1p(1000) - log1p(10))
    expect(logSalesNorm(100, salesStats(1000, 10))).toBeCloseTo(
      (Math.log1p(100) - Math.log1p(10)) / (Math.log1p(1000) - Math.log1p(10)),
      10,
    );
  });

  it('clamps to 0..1 (defensive against out-of-range sales)', () => {
    expect(logSalesNorm(5000, salesStats(1000, 0))).toBeCloseTo(1, 10);
    expect(logSalesNorm(-5, salesStats(1000, 0))).toBe(0);
  });
});

describe('computeCardPageStats', () => {
  const card = (over: Partial<CardSignals> & { id: string }): CardSignals => ({
    rating: null,
    reviewCount: 0,
    price: null,
    sponsored: false,
    ...over,
  });

  it('computes price mean/stddev identical to the price-only builder', () => {
    const stats = computeCardPageStats([
      card({ id: 'a', price: 100 }),
      card({ id: 'b', price: 200 }),
      card({ id: 'c', price: 300 }),
    ]);
    expect(stats.mean).toBeCloseTo(200, 10);
    expect(stats.stddev).toBeCloseTo(Math.sqrt(20000 / 3), 10);
  });

  it('ratingMean averages only present finite ratings (nulls excluded)', () => {
    const stats = computeCardPageStats([
      card({ id: 'a', rating: 4 }),
      card({ id: 'b', rating: null }),
      card({ id: 'c', rating: 5 }),
    ]);
    expect(stats.ratingMean).toBeCloseTo(4.5, 10);
  });

  it('ratingMean is 0 when no rating is present', () => {
    const stats = computeCardPageStats([card({ id: 'a', rating: null }), card({ id: 'b', rating: null })]);
    expect(stats.ratingMean).toBe(0);
  });

  it('maxSales/minSales track non-negative sold counts across the page', () => {
    const stats = computeCardPageStats([
      card({ id: 'a', reviewCount: 10 }),
      card({ id: 'b', reviewCount: 0 }),
      card({ id: 'c', reviewCount: 500 }),
    ]);
    expect(stats.maxSales).toBe(500);
    expect(stats.minSales).toBe(0);
  });

  it('treats a null reviewCount as 0 for sales stats', () => {
    const stats = computeCardPageStats([
      card({ id: 'a', reviewCount: null }),
      card({ id: 'b', reviewCount: 7 }),
    ]);
    expect(stats.maxSales).toBe(7);
    expect(stats.minSales).toBe(0);
  });

  it('returns all-zero stats for an empty page (degenerate, never throws)', () => {
    expect(computeCardPageStats([])).toEqual({
      mean: 0,
      stddev: 0,
      ratingMean: 0,
      maxSales: 0,
      minSales: 0,
    });
  });

  it('handles a single card: maxSales === minSales flags a degenerate logSalesNorm page', () => {
    const stats = computeCardPageStats([
      card({ id: 'only', rating: 4.8, reviewCount: 123, price: 100 }),
    ]);
    expect(stats.mean).toBe(100);
    expect(stats.stddev).toBe(0);
    expect(stats.ratingMean).toBeCloseTo(4.8, 10);
    expect(stats.maxSales).toBe(123);
    expect(stats.minSales).toBe(123);
    // Degenerate sales page -> logSalesNorm MUST be 0 for the single card.
    expect(logSalesNorm(123, stats)).toBe(0);
  });
});
