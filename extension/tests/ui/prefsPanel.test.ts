// Preferences panel UI tests (Phase 5 + Phase 6.3 invariant).
//
// The panel is a small collapsed square fixed bottom-right, ABOVE the existing
// toggle pill (coexists, does not break it). Clicking it expands (CSS
// animation via attribute/class toggle) into a panel with the 4 Spanish preset
// chips {Balanceado, Mejor valorados, Mas vendidos, Economicos} + w1/w2/w4
// sliders (w3 and priorC stay advanced/defaulted). Preset clicks fire
// onConfigChange immediately; slider moves are debounced ~200ms. Every change
// persists via savePrefs (localStorage `ml-rerank:prefs:v1`) and calls
// onConfigChange(next) â€” the caller maps that to reorderer.updateConfig (ZERO
// network, Pilar 1 invariant â€” asserted in the Phase 6.3 block below).
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

const PRESETS = ['Balanceado', 'Mejor valorados', 'MÃ¡s vendidos', 'EconÃ³micos'] as const;

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

/** The CSS `order` of a node as a number; unset (`''`) sorts last. */
function cssOrderOf(el: HTMLElement): number {
  const v = el.style.order;
  return v === '' ? Number.POSITIVE_INFINITY : Number(v);
}

/** Card ids in VISUAL (applied) order: sorted by the CSS `order` the reorderer
 *  sets, DOM index breaking ties. The reorderer never moves DOM nodes. */
function appliedIds(root: ParentNode = container): string[] {
  return parseCards(root)
    .map((c, i) => ({ id: c.id, order: cssOrderOf(c.nodeRef as HTMLElement), i }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((x) => x.id);
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

function getSlider(weight: 'w1' | 'w2' | 'w4' | 'w7'): HTMLInputElement {
  const el = document.body.querySelector(`[data-ml-weight="${weight}"]`);
  expect(el, `slider for ${weight} exists`).not.toBeNull();
  return el as HTMLInputElement;
}

function getShippingSwitch(): HTMLInputElement {
  const el = document.body.querySelector('[data-ml-switch="shipping"]');
  expect(el, 'shipping switch exists').not.toBeNull();
  return el as HTMLInputElement;
}

function clearPrefs(): void {
  try {
    localStorage.removeItem(PREFS_STORAGE_KEY);
  } catch {
    // storage blocked in this test â€” nothing to clear
  }
}

describe('prefsPanel UI â€” expand/collapse (Phase 5.1)', () => {
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

describe('prefsPanel â€” preset chips (Phase 5.2)', () => {
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
    const expected = presetToConfig('MÃ¡s vendidos');
    getChip('MÃ¡s vendidos').click();

    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(expected);
  });

  it('preset click syncs the sliders to the preset weights', () => {
    const preset = presetToConfig('EconÃ³micos'); // w1:0.2, w2:1.0, w4:0.2
    getChip('EconÃ³micos').click();

    expect(parseFloat(getSlider('w1').value)).toBeCloseTo(preset.w1, 5);
    expect(parseFloat(getSlider('w2').value)).toBeCloseTo(preset.w2, 5);
    expect(parseFloat(getSlider('w4').value)).toBeCloseTo(preset.w4, 5);
  });
});

describe('prefsPanel â€” active preset highlight', () => {
  beforeEach(() => {
    freshFixture();
    onConfigChange = vi.fn();
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    clearPrefs();
  });

  function pressed(label: string): string | null {
    return getChip(label).getAttribute('aria-pressed');
  }

  it('highlights the chip matching the initial config on mount (Balanceado = defaults)', () => {
    panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
    panel.expand();

    expect(pressed('Balanceado')).toBe('true');
    expect(pressed('Mejor valorados')).toBe('false');
    expect(pressed('MÃ¡s vendidos')).toBe('false');
    expect(pressed('EconÃ³micos')).toBe('false');
  });

  it('clicking a preset marks it active and clears the previously active chip', () => {
    panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
    panel.expand();

    getChip('Mejor valorados').click();

    expect(pressed('Mejor valorados')).toBe('true');
    expect(pressed('Balanceado')).toBe('false');
    // exactly one chip is active at a time
    const active = PRESETS.filter((l) => pressed(l) === 'true');
    expect(active).toEqual(['Mejor valorados']);
  });

  it('a custom slider move clears every active chip (no preset matches)', () => {
    vi.useFakeTimers();
    try {
      panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
      panel.expand();
      expect(pressed('Balanceado')).toBe('true'); // starts on a preset

      const w1 = getSlider('w1');
      w1.value = '1.9'; // off every preset
      w1.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(200);

      const active = PRESETS.filter((l) => pressed(l) === 'true');
      expect(active).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('prefsPanel â€” slider debounce + persistence (Phase 5.2)', () => {
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
      ...RANK_CONFIG,
      w1: 1.5,
      w2: RANK_CONFIG.w2,
      w4: RANK_CONFIG.w4,
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
      ...RANK_CONFIG,
      w1: 1.7,
      w2: RANK_CONFIG.w2,
      w4: RANK_CONFIG.w4,
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
      ...RANK_CONFIG,
      w1: RANK_CONFIG.w1,
      w2: 0.9,
      w4: RANK_CONFIG.w4,
    });
  });
});

describe('prefsPanel â€” zero-network on config change (Phase 6.3 invariant)', () => {
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
      reorderer.reorder(); // establish a baseline applied (default) order

      const economicos = presetToConfig('EconÃ³micos');
      // Expected applied order for the preset (DOM order never changes, so
      // parseCards always sees ML's original order).
      const expected = rank(parseCards(container), economicos).map((c) => c.id);
      expect(expected).not.toEqual(appliedIds()); // sanity: preset reorders

      panel.expand();
      getChip('EconÃ³micos').click();

      expect(appliedIds()).toEqual(expected); // re-ranked with the new config
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
        ...RANK_CONFIG,
        w1: 1.5,
        w2: RANK_CONFIG.w2,
        w4: RANK_CONFIG.w4,
      };
      const expected = rank(parseCards(container), sliderConfig).map((c) => c.id);
      expect(expected).not.toEqual(appliedIds()); // sanity: slider reorders

      const w1 = getSlider('w1');
      w1.value = '1.5';
      w1.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(200); // fire the debounced onConfigChange

      expect(appliedIds()).toEqual(expected); // re-ranked
      expect(fetchSpy).not.toHaveBeenCalled(); // zero network
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      panel.destroy();
    }
  });
});

describe('prefsPanel — Envío rápido switch + Descuento slider (new signals)', () => {
  // These tests exercise only the panel controls (no re-ranking), so they skip
  // the heavy 2.3MB fixture parse — mounting the panel is all that is needed.
  beforeEach(() => {
    onConfigChange = vi.fn();
    panel = mountPrefsPanel({ onConfigChange, initialConfig: RANK_CONFIG });
    panel.expand();
  });

  afterEach(() => {
    panel.destroy();
    document.body.innerHTML = '';
    clearPrefs();
  });

  it('renders the Descuento slider (w7) at the default weight', () => {
    expect(parseFloat(getSlider('w7').value)).toBeCloseTo(RANK_CONFIG.w7 ?? 0, 5);
  });

  it('moving the Descuento slider commits a config with the new w7 (debounced)', () => {
    vi.useFakeTimers();
    try {
      const w7 = getSlider('w7');
      w7.value = '0.8';
      w7.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(200);
      expect(onConfigChange).toHaveBeenCalledTimes(1);
      expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ w7: 0.8 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the Envío rápido switch ON by default (default w5/w6 > 0)', () => {
    expect(getShippingSwitch().checked).toBe(true);
  });

  it('turning the switch OFF zeroes both shipping boosts immediately (no debounce)', () => {
    const sw = getShippingSwitch();
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ w5: 0, w6: 0 }));
  });

  it('turning the switch back ON restores the default shipping boosts', () => {
    const sw = getShippingSwitch();
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    sw.checked = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ w5: RANK_CONFIG.w5, w6: RANK_CONFIG.w6 }),
    );
  });

  it('the switch leaves the slider weights (w1/w2/w4/w7) untouched', () => {
    const sw = getShippingSwitch();
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        w1: RANK_CONFIG.w1,
        w2: RANK_CONFIG.w2,
        w4: RANK_CONFIG.w4,
        w7: RANK_CONFIG.w7,
      }),
    );
  });
});
