// Default RankConfig — structural constant (task 1.5).
// Triangulation skipped: a constant has exactly one correct value set; the test
// pins each field so a future edit cannot silently drift the ranking defaults.

import { describe, it, expect } from 'vitest';

import { RANK_CONFIG } from '../src/config';

describe('RANK_CONFIG defaults', () => {
  it('exposes the v2 default weight set (w1..w4 + priorC)', () => {
    expect(RANK_CONFIG).toEqual({
      w1: 0.6,
      w2: 0.3,
      w3: 0.4,
      w4: 0.3,
      priorC: 5,
    });
  });

  it('keeps the v1 weights unchanged for backward-compatible importers', () => {
    expect(RANK_CONFIG.w1).toBe(0.6);
    expect(RANK_CONFIG.w2).toBe(0.3);
    expect(RANK_CONFIG.w3).toBe(0.4);
  });
});
