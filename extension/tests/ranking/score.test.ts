import { describe, it, expect } from 'vitest';

import { RANK_CONFIG } from '../../src/config';
import { ratingNorm, computePageStats, priceNorm, sponsoredPenalty } from '../../src/ranking/normalize';
import { computeQualityScore, rank } from '../../src/ranking/score';
import type { CardSignals, ParsedCard, RankConfig } from '../../src/ranking/types';

/**
 * Build a plain CardSignals object (no DOM). The ranking module is generic over
 * CardSignals so the pure core is unit-testable without any DOM dependency.
 */
function card(over: Partial<CardSignals> & { id: string }): CardSignals {
  return { rating: null, reviewCount: 0, price: null, sponsored: false, ...over };
}

/** Build a ParsedCard carrying a fake nodeRef (kept opaque — ranking never inspects it). */
function parsedCard(over: Partial<CardSignals> & { id: string }, nodeRef: HTMLElement): ParsedCard {
  return { ...card(over), nodeRef };
}

const CFG: RankConfig = RANK_CONFIG; // w1=0.6, w2=0.3, w3=0.4

describe('normalize', () => {
  describe('ratingNorm', () => {
    it('clamps rating to 0..5 then divides by 5', () => {
      expect(ratingNorm(0)).toBeCloseTo(0, 10);
      expect(ratingNorm(5)).toBeCloseTo(1, 10);
      expect(ratingNorm(4.8)).toBeCloseTo(0.96, 10);
      expect(ratingNorm(7)).toBeCloseTo(1, 10); // clamped down
      expect(ratingNorm(-2)).toBeCloseTo(0, 10); // clamped up
    });

    it('treats null rating as 0 (no signal = no boost)', () => {
      expect(ratingNorm(null)).toBe(0);
    });
  });

  describe('computePageStats', () => {
    it('computes mean and stddev over present prices only', () => {
      const stats = computePageStats([100, 200, 300, null]);
      expect(stats.mean).toBeCloseTo(200, 10);
      // variance = ((100-200)^2 + 0 + (300-200)^2)/3 = 20000/3 -> stddev ~ 81.6497
      expect(stats.stddev).toBeCloseTo(Math.sqrt(20000 / 3), 10);
    });

    it('returns mean=0, stddev=0 when no price is present', () => {
      const stats = computePageStats([null, null]);
      expect(stats.mean).toBe(0);
      expect(stats.stddev).toBe(0);
    });

    it('returns stddev=0 for uniform prices (epsilon denominator path)', () => {
      const stats = computePageStats([100, 100, 100]);
      expect(stats.mean).toBe(100);
      expect(stats.stddev).toBe(0);
    });
  });

  describe('priceNorm', () => {
    it('returns 0 for null/missing price', () => {
      expect(priceNorm(null, { mean: 100, stddev: 20 })).toBe(0);
    });

    it('returns (mean - price) / max(stddev, 1e-6); cheaper-than-mean is positive', () => {
      expect(priceNorm(50, { mean: 100, stddev: 20 })).toBeCloseTo(2.5, 10);
      expect(priceNorm(150, { mean: 100, stddev: 20 })).toBeCloseTo(-2.5, 10);
    });

    it('uses the epsilon denominator when stddev is 0 and produces a finite value', () => {
      // uniform prices: mean == price -> (mean - price) = 0 -> 0 / 1e-6 = 0 (finite, not NaN/Infinity)
      const n = priceNorm(100, { mean: 100, stddev: 0 });
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBe(0);
    });

    it('is finite even for price 0 with a zero stddev page', () => {
      const n = priceNorm(0, { mean: 0, stddev: 0 });
      expect(Number.isFinite(n)).toBe(true);
    });
  });

  describe('sponsoredPenalty', () => {
    it('is 1 when sponsored, 0 otherwise', () => {
      expect(sponsoredPenalty(true)).toBe(1);
      expect(sponsoredPenalty(false)).toBe(0);
    });
  });
});

describe('computeQualityScore', () => {
  it('applies the formula score = w1*ratingNorm + w2*priceNorm - w3*sponsoredPenalty', () => {
    const stats = { mean: 100, stddev: 20 };
    // rating=5 -> 1, price=50 -> (100-50)/20 = 2.5, not sponsored -> 0
    // score = 0.6*1 + 0.3*2.5 - 0.4*0 = 0.6 + 0.75 = 1.35
    expect(computeQualityScore(card({ id: 'a', rating: 5, reviewCount: 10, price: 50, sponsored: false }), stats, CFG)).toBeCloseTo(1.35, 10);
  });

  it('subtracts the sponsored penalty', () => {
    const stats = { mean: 100, stddev: 20 };
    const base = computeQualityScore(card({ id: 'a', rating: 5, reviewCount: 10, price: 50, sponsored: false }), stats, CFG);
    const sponsored = computeQualityScore(card({ id: 'b', rating: 5, reviewCount: 10, price: 50, sponsored: true }), stats, CFG);
    expect(base - sponsored).toBeCloseTo(CFG.w3, 10); // 0.4
  });

  it('produces a finite score for missing rating and missing price', () => {
    const stats = computePageStats([null, null]);
    const s = computeQualityScore(card({ id: 'a', rating: null, reviewCount: 0, price: null, sponsored: false }), stats, CFG);
    expect(Number.isFinite(s)).toBe(true);
  });

  it('produces finite scores on a uniform-price page (epsilon denominator)', () => {
    const stats = computePageStats([100, 100, 100]);
    const s = computeQualityScore(card({ id: 'a', rating: 4, reviewCount: 5, price: 100, sponsored: false }), stats, CFG);
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe('rank', () => {
  it('returns an empty array for empty input', () => {
    expect(rank([], CFG)).toEqual([]);
  });

  it('leaves a single card unchanged (one element, finite score)', () => {
    const only = parsedCard({ id: 'a', rating: 4.8, reviewCount: 123, price: 100, sponsored: false }, {} as HTMLElement);
    const out = rank([only], CFG);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(Number.isFinite(out[0].qualityScore)).toBe(true);
    expect(out[0].originalIndex).toBe(0);
  });

  it('moves a rated card above an unrated card with equal other signals', () => {
    const a = parsedCard({ id: 'a', rating: 4.8, reviewCount: 100, price: 100, sponsored: false }, {} as HTMLElement);
    const b = parsedCard({ id: 'b', rating: null, reviewCount: 0, price: 100, sponsored: false }, {} as HTMLElement);
    const out = rank([b, a], CFG); // input order: unrated first
    expect(out.map((c) => c.id)).toEqual(['a', 'b']); // rated moves up
  });

  it('demotes a sponsored card below an equal-signal non-sponsored card', () => {
    const organic = parsedCard({ id: 'org', rating: 4.5, reviewCount: 50, price: 100, sponsored: false }, {} as HTMLElement);
    const ad = parsedCard({ id: 'ad', rating: 4.5, reviewCount: 50, price: 100, sponsored: true }, {} as HTMLElement);
    const out = rank([ad, organic], CFG); // sponsored input first
    expect(out.map((c) => c.id)).toEqual(['org', 'ad']); // organic sinks the ad
  });

  it('preserves original order on exact ties (no reliability tie-break difference)', () => {
    const a = parsedCard({ id: 'a', rating: 4.5, reviewCount: 50, price: 100, sponsored: false }, {} as HTMLElement);
    const b = parsedCard({ id: 'b', rating: 4.5, reviewCount: 50, price: 100, sponsored: false }, {} as HTMLElement);
    const out = rank([a, b], CFG);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']); // original order preserved
  });

  it('breaks score ties by reviewCount desc before original index (documented reliability tie-break)', () => {
    // Equal score (same rating/price/sponsored), different reviewCount.
    const fewer = parsedCard({ id: 'fewer', rating: 4.5, reviewCount: 10, price: 100, sponsored: false }, {} as HTMLElement);
    const more = parsedCard({ id: 'more', rating: 4.5, reviewCount: 999, price: 100, sponsored: false }, {} as HTMLElement);
    const out = rank([fewer, more], CFG); // fewer first in input
    expect(out.map((c) => c.id)).toEqual(['more', 'fewer']); // higher reviewCount wins
  });

  it('is deterministic: identical input + config yields identical scores and order across runs', () => {
    const cards = [
      parsedCard({ id: 'a', rating: 4.8, reviewCount: 100, price: 80, sponsored: false }, {} as HTMLElement),
      parsedCard({ id: 'b', rating: null, reviewCount: 0, price: 200, sponsored: false }, {} as HTMLElement),
      parsedCard({ id: 'c', rating: 3.0, reviewCount: 12, price: 80, sponsored: true }, {} as HTMLElement),
    ];
    const run1 = rank(cards, CFG);
    const run2 = rank(cards, CFG);
    expect(run1.map((c) => c.id)).toEqual(run2.map((c) => c.id));
    expect(run1.map((c) => c.qualityScore)).toEqual(run2.map((c) => c.qualityScore));
  });

  it('produces only finite scores for a page mixing missing data and uniform prices', () => {
    const cards = [
      parsedCard({ id: 'a', rating: null, reviewCount: 0, price: null, sponsored: false }, {} as HTMLElement),
      parsedCard({ id: 'b', rating: 4, reviewCount: 5, price: 100, sponsored: false }, {} as HTMLElement),
      parsedCard({ id: 'c', rating: 5, reviewCount: 9, price: 100, sponsored: true }, {} as HTMLElement),
    ];
    const out = rank(cards, CFG);
    expect(out.every((c) => Number.isFinite(c.qualityScore))).toBe(true);
  });

  it('carries nodeRef through to the scored output (reorderer contract)', () => {
    const node = { tagName: 'LI' } as HTMLElement;
    const a = parsedCard({ id: 'a', rating: 5, reviewCount: 1, price: 100, sponsored: false }, node);
    const out = rank([a], CFG);
    expect(out[0].nodeRef).toBe(node);
  });
});
