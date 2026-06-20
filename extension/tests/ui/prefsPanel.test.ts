// Preferences panel UI tests (Phase 5 + Phase 6.3 invariant).
//
// The panel is a small collapsed square fixed bottom-right, ABOVE the existing
// toggle pill (coexists, does not break it). Clicking it expands (CSS
// animation via attribute/class toggle) into a panel with the 4 Spanish preset
// chips {Balanceado, Mejor valorados, Mas vendidos, Economicos} + w1/w2/w4
// sliders (w3 and priorC stay advanced/defaulted). Preset clicks fire
// onConfigChange immediately; slider moves are debounced ~200ms. Every change
// persists via savePrefs (localStorage `ml-rerank:prefs:v1`) and calls
// onConfigChange(next) — the caller maps that to reorderer.updateConfig (ZERO
// network, Pilar 1 invariant — asserted in the Phase 6.3 block below).
//
// Patterns mirror tests/ui/toggle.test.ts: a JSDOM fixture provides the
// container; the panel + localStorage live on the global vitest jsdom window
// (real listing URL in vitest.config.ts -> non-opaque origin).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { findContainer, parseCards } from '../../src/adapter/mercadolibre';
import { rank } from '../../src/ranking/score';
import { RANK_CONFIG } from '../../src/config';
import type { RankConfig } from '../../src/ranking/types';
import { createReorderer } from '../../src/observe';
import { mountToggle, type ToggleController } from '../../src/ui/toggle';
import {
  mountPrefsPanel,
  type PrefsPanelController,
} from '../../src/ui/prefsPanel';
import { presetToConfig, PREFS_STORAGE_KEY } from '../../src/prefs/rankingPrefs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'ml-search.html');
const html = readFileSync(fixturePath, 'utf8');

const PRESETS = ['Balanceado', 'Mejor valorados', 'Más vendidos', 'Económicos'] as const;

let dom: JSDOM;
let fixtureDoc: Document;
let container: HTMLElement;
let panel: PrefsPanelController;
let onConfigChange: ReturnType<typeof vi.fn>;

function freshFixture(): void {
  dom = new JSDOM(html, { url: 'https://listado.mercadolibre.com.ar/' });
  fixtureDoc = dom.window.document;
  const found = findContainer(fixtureDoc);
  expect(found).not.toBeNull();
  container = found!;
}

function cardIds(root: ParentNode = container): string[] {
  return parseCards(root).map((c) => c.id);
}

function getSquare(): HTMLElement {
  const el = document.body.querySelector('.ml-rerank-prefs');
  expect(el, 'collapsed square .ml-rerank-prefs is mounted').not.toBeNull();
  return el as HTMLElement;
}

function getPanelEl(): HTMLElement {
  const el = document.body.querySelector('.ml-rerank-prefs__panel');
  expect(el, 'expanded panel .ml-rerank-prefs__panel is mounted').not.toBeNull();
  return el as HTMLElement;
}

function getChip(label: string): HTMLElement {
  const el = document.body.querySelector(`[data-ml-preset="${label}"]`);
  expect(el, `preset chip "${label}" exists`).not.toBeNull();
  return el as HTMLElement;
}

function getSlider(weight: 'w1' | 'w2' | 'w4'): HTMLInputElement {
  const el = document.body.querySelector(`[data-ml-weight="${weight}"]`);
  expect(el, `slider for ${weight} exists`).not.toBeNull();
  return el as HTMLInputElement;
}

function clearPrefs(): void {
  try {
    localStorage.removeItem(PREFS_STORAGE_KEY);
  } catch {
    // storage blocked in this test — nothing to clear
  }
}

describe('prefsPanel UI — expand/collapse (Phase 5.1)', () => {
  beforeEach(() => {
    freshFixture();
    onConfigChange = vi.fn();
    panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    clearPrefs();
  });

  it('mounts a collapsed square .ml-rerank-prefs with aria-expanded=false', () => {
    const square = getSquare();
    expect(square.tagName).toBe('BUTTON');
    expect(square.getAttribute('aria-expanded')).toBe('false');
    // "fixed bottom-right above the toggle pill" is enforced by content.css
    // (.ml-rerank-prefs { position:fixed; right:16px; bottom:64px }); jsdom
    // does not apply stylesheets, so the class presence is the test hook.
    expect(square.classList.contains('ml-rerank-prefs')).toBe(true);
  });

  it('the collapsed panel is hidden at mount (animation attribute = false)', () => {
    const panelEl = getPanelEl();
    expect(panelEl.getAttribute('data-ml-prefs-open')).toBe('false');
  });

  it('clicking the square expands: aria-expanded=true and panel open attribute flips', () => {
    const square = getSquare();
    square.click();

    expect(square.getAttribute('aria-expanded')).toBe('true');
    expect(getPanelEl().getAttribute('data-ml-prefs-open')).toBe('true');
    expect(panel.isExpanded()).toBe(true);
  });

  it('clicking again collapses: aria-expanded=false and panel hidden', () => {
    const square = getSquare();
    square.click(); // expand
    expect(panel.isExpanded()).toBe(true);

    square.click(); // collapse
    expect(square.getAttribute('aria-expanded')).toBe('false');
    expect(getPanelEl().getAttribute('data-ml-prefs-open')).toBe('false');
    expect(panel.isExpanded()).toBe(false);
  });

  it('expand()/collapse() controller methods toggle the same attributes', () => {
    panel.expand();
    expect(getSquare().getAttribute('aria-expanded')).toBe('true');
    expect(getPanelEl().getAttribute('data-ml-prefs-open')).toBe('true');
    expect(panel.isExpanded()).toBe(true);

    panel.collapse();
    expect(getSquare().getAttribute('aria-expanded')).toBe('false');
    expect(getPanelEl().getAttribute('data-ml-prefs-open')).toBe('false');
    expect(panel.isExpanded()).toBe(false);
  });

  it('destroy() removes both the square and the panel from the DOM', () => {
    expect(document.body.querySelector('.ml-rerank-prefs')).not.toBeNull();
    expect(document.body.querySelector('.ml-rerank-prefs__panel')).not.toBeNull();

    panel.destroy();

    expect(document.body.querySelector('.ml-rerank-prefs')).toBeNull();
    expect(document.body.querySelector('.ml-rerank-prefs__panel')).toBeNull();
  });

  it('coexists with the toggle pill (both mounted, neither breaks the other)', () => {
    const toggle = mountToggle(container, createReorderer(container));
    try {
      expect(document.body.querySelector('.ml-rerank-toggle')).not.toBeNull();
      expect(document.body.querySelector('.ml-rerank-prefs')).not.toBeNull();
      // Expanding the prefs panel does not affect the toggle pill.
      panel.expand();
      expect(document.body.querySelector('.ml-rerank-toggle')).not.toBeNull();
      expect(getSquare().getAttribute('aria-expanded')).toBe('true');
    } finally {
      toggle.destroy();
    }
  });
});

describe('prefsPanel — preset chips (Phase 5.2)', () => {
  beforeEach(() => {
    freshFixture();
    onConfigChange = vi.fn();
    panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
    panel.expand();
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    clearPrefs();
  });

  it('renders exactly the 4 Spanish preset chips with canonical labels', () => {
    for (const label of PRESETS) {
      const chip = getChip(label);
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.textContent?.trim()).toBe(label);
    }
    const allChips = Array.from(document.body.querySelectorAll('[data-ml-preset]'));
    expect(allChips).toHaveLength(4);
  });

  it('preset chip click calls onConfigChange with the preset config (immediate, no debounce)', () => {
    const expected = presetToConfig('Mejor valorados');
    getChip('Mejor valorados').click();

    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange).toHaveBeenCalledWith(expected);
  });

  it('clicking Balanceado calls onConfigChange with the defaults', () => {
    getChip('Balanceado').click();
    expect(onConfigChange).toHaveBeenCalledWith(RANK_CONFIG);
  });

  it('preset click persists the config via savePrefs (localStorage round-trip)', () => {
    const expected = presetToConfig('Más vendidos');
    getChip('Más vendidos').click();

    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(expected);
  });

  it('preset click syncs the sliders to the preset weights', () => {
    const preset = presetToConfig('Económicos'); // w1:0.2, w2:1.0, w4:0.2
    getChip('Económicos').click();

    expect(parseFloat(getSlider('w1').value)).toBeCloseTo(preset.w1, 5);
    expect(parseFloat(getSlider('w2').value)).toBeCloseTo(preset.w2, 5);
    expect(parseFloat(getSlider('w4').value)).toBeCloseTo(preset.w4, 5);
  });
});

describe('prefsPanel — slider debounce + persistence (Phase 5.2)', () => {
  beforeEach(() => {
    freshFixture();
    onConfigChange = vi.fn();
    panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
    panel.expand();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    panel.destroy();
    document.body.innerHTML = '';
    clearPrefs();
  });

  it('a slider move does NOT call onConfigChange before the ~200ms debounce elapses', () => {
    const w1 = getSlider('w1');
    w1.value = '1.5';
    w1.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(150);
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('after ~200ms the debounced onConfigChange fires once with the custom config', () => {
    const w1 = getSlider('w1');
    w1.value = '1.5';
    w1.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(200);

    expect(onConfigChange).toHaveBeenCalledTimes(1);
    // w1 overridden by the slider; w2/w4 stay at the initial slider values;
    // w3 and priorC are advanced/defaulted (kept from the initial config).
    expect(onConfigChange).toHaveBeenCalledWith({
      w1: 1.5,
      w2: RANK_CONFIG.w2,
      w3: RANK_CONFIG.w3,
      w4: RANK_CONFIG.w4,
      priorC: RANK_CONFIG.priorC,
    });
  });

  it('multiple slider moves within 200ms coalesce into a single onConfigChange call', () => {
    const w1 = getSlider('w1');
    for (const v of ['1.5', '1.6', '1.7']) {
      w1.value = v;
      w1.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(200); // pass the debounce window

    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange).toHaveBeenCalledWith({
      w1: 1.7,
      w2: RANK_CONFIG.w2,
      w3: RANK_CONFIG.w3,
      w4: RANK_CONFIG.w4,
      priorC: RANK_CONFIG.priorC,
    });
  });

  it('slider change persists the custom config via savePrefs after the debounce', () => {
    const w2 = getSlider('w2');
    w2.value = '0.9';
    w2.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(200);

    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      w1: RANK_CONFIG.w1,
      w2: 0.9,
      w3: RANK_CONFIG.w3,
      w4: RANK_CONFIG.w4,
      priorC: RANK_CONFIG.priorC,
    });
  });
});

describe('prefsPanel — zero-network on config change (Phase 6.3 invariant)', () => {
  beforeEach(() => freshFixture());

  afterEach(() => {
    document.body.innerHTML = '';
    clearPrefs();
  });

  it('a preset change re-ranks the current DOM with ZERO fetch calls', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const reorderer = createReorderer(container);
      panel = mountPrefsPanel({
        onConfigChange: (next: RankConfig) => reorderer.updateConfig(next),
        initialConfig: RANK_CONFIG,
      });
      reorderer.reorder(); // establish a baseline ranked order

      const economicos = presetToConfig('Económicos');
      // Expected order derived from the CURRENT DOM right before the change
      // (rank originalIndex tie-break is input-order sensitive).
      const expected = rank(parseCards(container), economicos).map((c) => c.id);
      expect(expected).not.toEqual(cardIds()); // sanity: preset reorders

      panel.expand();
      getChip('Económicos').click();

      expect(cardIds()).toEqual(expected); // re-ranked with the new config
      expect(fetchSpy).not.toHaveBeenCalled(); // Pilar 1 zero-network preserved
    } finally {
      vi.unstubAllGlobals();
      panel.destroy();
    }
  });

  it('a slider change re-ranks the current DOM with ZERO fetch calls (after debounce)', () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const reorderer = createReorderer(container);
      panel = mountPrefsPanel({
        onConfigChange: (next: RankConfig) => reorderer.updateConfig(next),
        initialConfig: RANK_CONFIG,
      });
      reorderer.reorder(); // baseline ranked order

      panel.expand();
      const sliderConfig: RankConfig = {
        w1: 1.5,
        w2: RANK_CONFIG.w2,
        w3: RANK_CONFIG.w3,
        w4: RANK_CONFIG.w4,
        priorC: RANK_CONFIG.priorC,
      };
      const expected = rank(parseCards(container), sliderConfig).map((c) => c.id);
      expect(expected).not.toEqual(cardIds()); // sanity: slider reorders

      const w1 = getSlider('w1');
      w1.value = '1.5';
      w1.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(200); // fire the debounced onConfigChange

      expect(cardIds()).toEqual(expected); // re-ranked
      expect(fetchSpy).not.toHaveBeenCalled(); // zero network
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      panel.destroy();
    }
  });
});
