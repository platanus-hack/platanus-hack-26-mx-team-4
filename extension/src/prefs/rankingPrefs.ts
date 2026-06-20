// Ranking preferences — PURE core (Phase 2) + persistence adapter (Phase 3).
//
// Two layers live here:
//   1. PURE core (no DOM, no storage, no globals): `normalizePrefs` and
//      `presetToConfig`. They validate/clamp/merge raw input against the
//      default `RankConfig` and map preset names to complete weight sets. They
//      NEVER throw on corrupt input (spec: "Missing, corrupt, invalid, or
//      unavailable ... MUST fall back to defaults and MUST NOT throw").
//   2. PERSISTENCE adapter (Phase 3): `loadPrefs` / `savePrefs` read/write the
//      page's `localStorage` key `ml-rerank:prefs:v1`, mirroring the exact
//      opaque-origin try/catch fallback of `src/ui/toggle.ts`. Any storage
//      failure (opaque origin, privacy mode, quota, disabled) degrades to the
//      in-memory defaults and never lets an exception escape.
//
// Canonical preset identifiers are the Spanish UI chip labels (tasks #800
// Phase 2.1 + design #799): Balanceado, Mejor valorados, Más vendidos,
// Económicos. Matching is accent- and case-insensitive so labels and stored
// keys stay robust against ML's varied formatting.

import type { RankConfig } from '../ranking/types';
import { RANK_CONFIG } from '../config';

/** Page localStorage key for the persisted ranking prefs (versioned). */
export const PREFS_STORAGE_KEY = 'ml-rerank:prefs:v1';

/**
 * Complete RankConfig weight sets for each preset.
 *
 *   w3 (sponsored penalty) is held >= default across presets so sponsored
 *   listings always sink; `priorC` keeps the default Bayesian prior. The presets
 *   vary w1 (trust) / w2 (price) / w4 (volume) to emphasize the named signal:
 *     Balanceado      — the defaults (balanced across signals)
 *     Mejor valorados — rating-dominant (w1 up, w2/w4 down)
 *     Más vendidos    — volume-dominant (w4 up, w1/w2 down)
 *     Económicos      — price-dominant (w2 up, w1/w4 down)
 */
const PRESETS: Readonly<Record<string, RankConfig>> = {
  balanceado: { w1: 0.6, w2: 0.3, w3: 0.4, w4: 0.3, priorC: 5 },
  'mejor valorados': { w1: 1.0, w2: 0.1, w3: 0.4, w4: 0.1, priorC: 5 },
  'mas vendidos': { w1: 0.3, w2: 0.2, w3: 0.4, w4: 1.0, priorC: 5 },
  economicos: { w1: 0.2, w2: 1.0, w3: 0.4, w4: 0.2, priorC: 5 },
};

/** `Balanceado` is exactly the default config (single source of truth). */
const DEFAULT_PRESET_KEY = 'balanceado';

/**
 * Normalize a preset label into a stable lookup key: trim, lowercase, and strip
 * diacritics (NFD + Diacritic removal) so "Más vendidos" / "MAS VENDIDOS" /
 * "mas vendidos" all collapse to "mas vendidos".
 */
function presetKey(preset: unknown): string {
  if (typeof preset !== 'string') return DEFAULT_PRESET_KEY;
  const stripped = preset
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
  return stripped.length === 0 ? DEFAULT_PRESET_KEY : stripped;
}

/**
 * Map a preset name to a COMPLETE `RankConfig`. Unknown / empty / non-string
 * presets fall back to `Balanceado` (the defaults). Always returns a fresh
 * object so callers cannot mutate the shared preset table.
 */
export function presetToConfig(preset: string): RankConfig {
  const key = presetKey(preset);
  const cfg = PRESETS[key] ?? PRESETS[DEFAULT_PRESET_KEY];
  return { ...cfg };
}

/**
 * Coerce a single raw field into a valid weight: a finite number >= 0, or the
 * provided default when the value is missing / non-finite / a non-number.
 * Strings are NOT coercively parsed (`"0.6"` is treated as invalid) so stored
 * corrupt shapes never smuggle through.
 */
function normalizeField(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/**
 * Validate / clamp / merge a raw prefs payload into a COMPLETE `RankConfig`.
 *
 *   - null / undefined / non-object / Array -> defaults (never throws).
 *   - missing fields -> defaults.
 *   - non-finite / non-number fields -> defaults for that field.
 *   - negative fields -> clamped to 0 (>= 0 invariant).
 *   - extra keys -> ignored.
 *
 * Returns a fresh object (defensive clone); the input is never mutated.
 */
export function normalizePrefs(raw: unknown): RankConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...RANK_CONFIG };
  }
  const r = raw as Record<string, unknown>;
  return {
    w1: normalizeField(r.w1, RANK_CONFIG.w1),
    w2: normalizeField(r.w2, RANK_CONFIG.w2),
    w3: normalizeField(r.w3, RANK_CONFIG.w3),
    w4: normalizeField(r.w4, RANK_CONFIG.w4),
    priorC: normalizeField(r.priorC, RANK_CONFIG.priorC),
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — persistence adapter (side-effectful, isolated).
// Mirrors `src/ui/toggle.ts` opaque-origin try/catch fallback exactly: any
// localStorage access failure degrades to defaults and never throws.
// ---------------------------------------------------------------------------

/**
 * Load persisted ranking prefs from the page's `localStorage`.
 *
 *   valid stored   -> the stored config, normalized (clamped/merged).
 *   missing        -> defaults.
 *   corrupt JSON   -> defaults (no throw).
 *   invalid shape  -> defaults via `normalizePrefs` (no throw).
 *   storage throws -> defaults (opaque origin / privacy mode / disabled; no
 *                     exception escapes, mirroring `toggle.ts`).
 */
export function loadPrefs(): RankConfig {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw == null) return { ...RANK_CONFIG };
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return { ...RANK_CONFIG };
  }
}

/**
 * Persist `config` to the page's `localStorage` as JSON. Silently swallows any
 * storage failure (opaque origin / privacy mode / quota) so a save never breaks
 * the current page view — mirroring `toggle.ts`'s `writePersistedState`.
 */
export function savePrefs(config: RankConfig): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage unavailable — degrade gracefully; no exception escapes.
  }
}
