// Preferences pure-core tests (Phase 2 — WU2 part A).
//
// `normalizePrefs` and `presetToConfig` are PURE: no DOM, no storage, no
// globals. They validate/merge raw input against the default RankConfig and map
// preset names to complete weight sets. They MUST NEVER throw on corrupt input
// (spec: "Missing, corrupt, invalid, or unavailable ... MUST fall back to
// defaults and MUST NOT throw").
//
// Canonical preset identifiers are the Spanish chip labels (tasks #800 Phase
// 2.1 + design #799 UI section): Balanceado, Mejor valorados, Más vendidos,
// Económicos. Matching is accent- and case-insensitive so UI labels and stored
// keys stay robust.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { normalizePrefs, presetToConfig, loadPrefs, savePrefs } from '../../src/prefs/rankingPrefs';
import { RANK_CONFIG } from '../../src/config';
import type { RankConfig } from '../../src/ranking/types';

const DEFAULTS = RANK_CONFIG;
/** The versioned localStorage key (pinned here so a drift in the module is caught). */
const PREFS_KEY = 'ml-rerank:prefs:v1';

/** A complete, valid config distinct from every preset (used as stored input). */
const FULL_VALID: RankConfig = { w1: 0.9, w2: 0.2, w3: 0.5, w4: 0.4, priorC: 10 };

/** Every preset MUST resolve to a structurally complete, finite, non-negative
 *  RankConfig (no missing keys, no NaN/Infinity, no negatives). */
function expectCompleteConfig(cfg: RankConfig): void {
  expect(cfg).toEqual(
    expect.objectContaining({
      w1: expect.any(Number),
      w2: expect.any(Number),
      w3: expect.any(Number),
      w4: expect.any(Number),
      priorC: expect.any(Number),
    }),
  );
  for (const v of [cfg.w1, cfg.w2, cfg.w3, cfg.w4, cfg.priorC]) {
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  }
}

describe('presetToConfig — preset -> complete RankConfig', () => {
  it('Balanceado maps to the default weight set', () => {
    expect(presetToConfig('Balanceado')).toEqual(DEFAULTS);
  });

  it('Mejor valorados emphasizes the shrunk-rating weight (w1) over price/sales', () => {
    const cfg = presetToConfig('Mejor valorados');
    expectCompleteConfig(cfg);
    expect(cfg).toEqual({ w1: 1.0, w2: 0.1, w3: 0.4, w4: 0.1, priorC: 5 });
    // Rating-dominant: w1 strictly greater than every other signal weight.
    expect(cfg.w1).toBeGreaterThan(cfg.w2);
    expect(cfg.w1).toBeGreaterThan(cfg.w4);
  });

  it('Más vendidos emphasizes the log-sold volume weight (w4)', () => {
    const cfg = presetToConfig('Más vendidos');
    expectCompleteConfig(cfg);
    expect(cfg).toEqual({ w1: 0.3, w2: 0.2, w3: 0.4, w4: 1.0, priorC: 5 });
    expect(cfg.w4).toBeGreaterThan(cfg.w1);
    expect(cfg.w4).toBeGreaterThan(cfg.w2);
  });

  it('Económicos emphasizes the price-quality weight (w2)', () => {
    const cfg = presetToConfig('Económicos');
    expectCompleteConfig(cfg);
    expect(cfg).toEqual({ w1: 0.2, w2: 1.0, w3: 0.4, w4: 0.2, priorC: 5 });
    expect(cfg.w2).toBeGreaterThan(cfg.w1);
    expect(cfg.w2).toBeGreaterThan(cfg.w4);
  });

  it('keeps the sponsored penalty (w3) >= default across presets so ads still sink', () => {
    for (const preset of ['Balanceado', 'Mejor valorados', 'Más vendidos', 'Económicos']) {
      expect(presetToConfig(preset).w3).toBeGreaterThanOrEqual(DEFAULTS.w3);
    }
  });

  it('matching is accent- and case-insensitive (UI labels vary)', () => {
    expect(presetToConfig('mas vendidos')).toEqual(presetToConfig('Más vendidos'));
    expect(presetToConfig('MAS VENDIDOS')).toEqual(presetToConfig('Más vendidos'));
    expect(presetToConfig('economicos')).toEqual(presetToConfig('Económicos'));
    expect(presetToConfig('  Mejor Valorados  ')).toEqual(presetToConfig('Mejor valorados'));
  });

  it('unknown / empty / non-string preset falls back to defaults (Balanceado)', () => {
    expect(presetToConfig('no-existe')).toEqual(DEFAULTS);
    expect(presetToConfig('')).toEqual(DEFAULTS);
    expect(presetToConfig(null as unknown as string)).toEqual(DEFAULTS);
    expect(presetToConfig(undefined as unknown as string)).toEqual(DEFAULTS);
    expect(presetToConfig(42 as unknown as string)).toEqual(DEFAULTS);
  });

  it('returns a fresh object each call (no shared mutable preset reference)', () => {
    const a = presetToConfig('Balanceado');
    const b = presetToConfig('Balanceado');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.w1 = 999;
    expect(presetToConfig('Balanceado').w1).toBe(DEFAULTS.w1);
  });
});

describe('normalizePrefs — validate / clamp / merge defaults, never throw', () => {
  it('null / undefined / non-object input -> defaults', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULTS);
    expect(normalizePrefs(undefined)).toEqual(DEFAULTS);
    expect(normalizePrefs('not-an-object')).toEqual(DEFAULTS);
    expect(normalizePrefs(42)).toEqual(DEFAULTS);
    expect(normalizePrefs(true)).toEqual(DEFAULTS);
  });

  it('an Array (corrupt shape) -> defaults, no throw', () => {
    expect(normalizePrefs([0.6, 0.3, 0.4, 0.3, 5])).toEqual(DEFAULTS);
    expect(normalizePrefs([])).toEqual(DEFAULTS);
  });

  it('an empty object -> defaults', () => {
    expect(normalizePrefs({})).toEqual(DEFAULTS);
  });

  it('a complete valid config is returned as an equal clone (no mutation of input)', () => {
    const input = { ...FULL_VALID };
    const out = normalizePrefs(input);
    expect(out).toEqual(FULL_VALID);
    expect(out).not.toBe(input); // defensive clone
    // Input is untouched.
    expect(input).toEqual(FULL_VALID);
  });

  it('merges defaults for missing fields (partial slider input)', () => {
    expect(normalizePrefs({ w1: 0.9 })).toEqual({ ...DEFAULTS, w1: 0.9 });
    expect(normalizePrefs({ w4: 0.8 })).toEqual({ ...DEFAULTS, w4: 0.8 });
    expect(normalizePrefs({ priorC: 12 })).toEqual({ ...DEFAULTS, priorC: 12 });
  });

  it('replaces invalid fields (NaN / non-number / Infinity) with defaults', () => {
    expect(normalizePrefs({ w1: Number.NaN })).toEqual({ ...DEFAULTS, w1: DEFAULTS.w1 });
    expect(normalizePrefs({ w2: 'big' as unknown as number })).toEqual(DEFAULTS);
    expect(normalizePrefs({ w3: null as unknown as number })).toEqual(DEFAULTS);
    expect(normalizePrefs({ w4: Number.POSITIVE_INFINITY })).toEqual({ ...DEFAULTS, w4: DEFAULTS.w4 });
    expect(normalizePrefs({ w1: '0.6' as unknown as number })).toEqual(DEFAULTS); // no coercive strings
  });

  it('clamps negative weights and priorC to 0 (>= 0 invariant)', () => {
    expect(normalizePrefs({ w1: -1 })).toEqual({ ...DEFAULTS, w1: 0 });
    expect(normalizePrefs({ w4: -0.5 })).toEqual({ ...DEFAULTS, w4: 0 });
    expect(normalizePrefs({ priorC: -3 })).toEqual({ ...DEFAULTS, priorC: 0 });
    const all = normalizePrefs({ w1: -1, w2: -2, w3: -3, w4: -4, priorC: -5 });
    expect(all).toEqual({ w1: 0, w2: 0, w3: 0, w4: 0, priorC: 0 });
  });

  it('keeps valid fields and defaults invalid ones in a mixed input', () => {
    expect(normalizePrefs({ w1: 0.7, w2: 'x' as unknown as number, w3: -1, w4: 0.5 })).toEqual({
      w1: 0.7,
      w2: DEFAULTS.w2,
      w3: 0,
      w4: 0.5,
      priorC: DEFAULTS.priorC,
    });
  });

  it('survives a battery of pathological inputs without throwing', () => {
    const weird: unknown[] = [
      Object.create(null),
      { w1: Object.create(null) },
      { w1: [], w2: {} },
      JSON.parse('{"w1":0.6,"w2":0.3,"w3":0.4,"w4":0.3,"priorC":5,"extra":"ignored"}'),
      Symbol('x') as unknown,
      NaN,
    ];
    for (const w of weird) {
      const out = normalizePrefs(w as Parameters<typeof normalizePrefs>[0]);
      expectCompleteConfig(out);
    }
    // Extra keys are ignored, valid fields kept.
    const withExtra = normalizePrefs({ w1: 0.6, extra: 'noise' } as unknown as Parameters<typeof normalizePrefs>[0]);
    expect(withExtra).toEqual({ ...DEFAULTS, w1: 0.6 });
  });
});

describe('manual slider override -> custom config (Phase 2.2)', () => {
  it('a partial slider override yields a complete custom config distinct from the active preset', () => {
    // User had "Balanceado" active, then nudges the sales slider to 0.9.
    const custom = normalizePrefs({ w4: 0.9 });
    expectCompleteConfig(custom);
    expect(custom).toEqual({ ...DEFAULTS, w4: 0.9 });
    // The custom config no longer matches any preset -> the active preset is
    // effectively overridden/cleared (UI concern; pure core just yields custom).
    expect(custom).not.toEqual(presetToConfig('Balanceado'));
    expect(custom).not.toEqual(presetToConfig('Más vendidos'));
  });

  it('a full manual override produces a config equal to the raw valid input', () => {
    const manual: RankConfig = { w1: 0.8, w2: 0.7, w3: 0.2, w4: 0.6, priorC: 8 };
    expect(normalizePrefs(manual)).toEqual(manual);
    expect(normalizePrefs(manual)).not.toBe(manual);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — persistence adapter (localStorage, opaque-origin fallback).
// Mirrors src/ui/toggle.ts: missing/corrupt/invalid/unavailable storage falls
// back to defaults and NEVER throws. Uses the global vitest jsdom window, which
// vitest.config.ts configures with the real ML listing URL so localStorage is
// available (non-opaque origin) — the same setup toggle.test.ts relies on.
// ---------------------------------------------------------------------------

/** Clear the prefs key so state never leaks between tests. Safe when the
 *  global localStorage accessor was stubbed to throw (no-op). */
function clearPrefs(): void {
  try {
    localStorage.removeItem(PREFS_KEY);
  } catch {
    // storage blocked in this test — nothing to clear
  }
}

describe('loadPrefs / savePrefs — localStorage persistence', () => {
  beforeEach(() => clearPrefs());
  afterEach(() => clearPrefs());

  it('loadPrefs returns defaults when the key is missing', () => {
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
    expect(loadPrefs()).toEqual(DEFAULTS);
  });

  it('savePrefs writes JSON to the versioned key, loadPrefs reads it back', () => {
    const cfg: RankConfig = { w1: 0.9, w2: 0.2, w3: 0.5, w4: 0.4, priorC: 10 };
    savePrefs(cfg);
    expect(localStorage.getItem(PREFS_KEY)).toBe(JSON.stringify(cfg));
    expect(loadPrefs()).toEqual(cfg);
  });

  it('loadPrefs uses the stored config for the first rank (valid stored prefs)', () => {
    const stored: RankConfig = { w1: 0.7, w2: 0.6, w3: 0.3, w4: 0.5, priorC: 7 };
    localStorage.setItem(PREFS_KEY, JSON.stringify(stored));
    expect(loadPrefs()).toEqual(stored);
  });

  it('loadPrefs falls back to defaults on corrupt JSON (no throw)', () => {
    localStorage.setItem(PREFS_KEY, '{not valid json');
    expect(() => loadPrefs()).not.toThrow();
    expect(loadPrefs()).toEqual(DEFAULTS);
  });

  it('loadPrefs falls back to defaults on a valid-JSON invalid shape (no throw)', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify('just-a-string'));
    expect(loadPrefs()).toEqual(DEFAULTS);
    localStorage.setItem(PREFS_KEY, JSON.stringify([1, 2, 3]));
    expect(loadPrefs()).toEqual(DEFAULTS);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ w1: 'bad' }));
    expect(loadPrefs()).toEqual(DEFAULTS);
  });

  it('loadPrefs normalizes/clamps stored values (negative -> 0, missing -> default)', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ w1: -1, w4: 0.9 }));
    expect(loadPrefs()).toEqual({ ...DEFAULTS, w1: 0, w4: 0.9 });
  });

  it('savePrefs -> loadPrefs round-trips a preset config unchanged', () => {
    const cfg = presetToConfig('Más vendidos');
    savePrefs(cfg);
    expect(loadPrefs()).toEqual(cfg);
  });

  // NOTE: the localStorage-throws tests are placed LAST in this block, mirroring
  // toggle.test.ts: `delete (window).localStorage` after stubbing does not
  // fully restore jsdom's prototype accessor for a LATER test in the same file,
  // so nothing after these two should rely on a working localStorage.

  it('loadPrefs never throws when localStorage access throws (opaque origin / privacy mode)', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new TypeError('localStorage is not available for opaque origins');
      },
      set: () => {
        throw new TypeError('localStorage is not available for opaque origins');
      },
    });
    try {
      expect(() => loadPrefs()).not.toThrow();
      expect(loadPrefs()).toEqual(DEFAULTS);
    } finally {
      // Remove the own accessor so the prototype accessor jsdom installed is
      // used again by subsequent tests.
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  it('savePrefs never throws when localStorage access throws (opaque origin / privacy mode)', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new TypeError('localStorage is not available for opaque origins');
      },
      set: () => {
        throw new TypeError('localStorage is not available for opaque origins');
      },
    });
    try {
      expect(() => savePrefs(DEFAULTS)).not.toThrow();
    } finally {
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });
});
