// Toggle UI tests — assert ON applies the ranked order and OFF restores the
// EXACT original order captured at mount (spec: "Visible Toggle and Exact
// Restore"). Also covers pagination persistence: the toggle state is persisted
// to the page's localStorage so re-ranking stays ON across ML's full-page
// pagination (`..._Desde_N`), and degrades gracefully to OFF when storage is
// unavailable (opaque origin / privacy mode — see jsdom opaque-origin discovery).
//
// The fixture is the source of truth for the card structure.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { findContainer, parseCards } from '../../src/adapter/mercadolibre';
import { rank } from '../../src/ranking/score';
import { RANK_CONFIG } from '../../src/config';
import { createReorderer } from '../../src/observe';
import { mountToggle, type ToggleController } from '../../src/ui/toggle';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'ml-search.html');
const html = readFileSync(fixturePath, 'utf8');

const STORAGE_KEY = 'ml-rerank:enabled';

let dom: JSDOM;
let fixtureDoc: Document;
let container: HTMLElement;
let toggle: ToggleController;

function freshFixture(): void {
  // A real listing URL gives jsdom a non-opaque origin (see observe.test.ts).
  // The container lives in this fixture document; the pill + localStorage live
  // on the global vitest jsdom window (also configured with a real URL in
  // vitest.config.ts), mirroring how a content script uses the page's storage.
  dom = new JSDOM(html, { url: 'https://listado.mercadolibre.com.ar/' });
  fixtureDoc = dom.window.document;
  const found = findContainer(fixtureDoc);
  expect(found).not.toBeNull();
  container = found!;
}

function cardIds(root: ParentNode = container): string[] {
  return parseCards(root).map((c) => c.id);
}

/** Clear persisted toggle state so it never leaks between tests. Safe when the
 *  global localStorage accessor was temporarily stubbed to throw (no-op). */
function clearPersistedState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked in this test — nothing to clear
  }
}

describe('toggle UI — fixture-grounded', () => {
  beforeEach(() => {
    freshFixture();
    toggle = mountToggle(container, createReorderer(container));
  });

  afterEach(() => {
    toggle.destroy();
    // Clean the global jsdom document (the pill is appended to document.body)
    // and clear persisted state so it never leaks into the next test.
    document.body.innerHTML = '';
    clearPersistedState();
  });

  it('mounts a visible, labeled pill in the document body', () => {
    const pill = document.body.querySelector('.ml-rerank-toggle');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('data-ml-rerank-state')).toBe('off');
    expect(pill!.getAttribute('aria-pressed')).toBe('false');
    expect(pill!.textContent).toContain('Re-rank: OFF');
  });

  it('starts OFF and leaves the original order untouched at mount', () => {
    const original = cardIds();
    expect(toggle.isOn()).toBe(false);
    expect(cardIds()).toEqual(original);
  });

  it('ON applies the ranked order and flips the pill state', () => {
    const expectedRankedIds = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

    toggle.on();

    expect(toggle.isOn()).toBe(true);
    expect(cardIds()).toEqual(expectedRankedIds);
    const pill = document.body.querySelector('.ml-rerank-toggle')!;
    expect(pill.getAttribute('data-ml-rerank-state')).toBe('on');
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(pill.textContent).toContain('Re-rank: ON');
  });

  it('OFF restores the EXACT original order captured at mount (incl. ties & sponsored)', () => {
    const original = cardIds(); // captured at mount, before any reorder

    toggle.on();
    expect(cardIds()).not.toEqual(original); // ranking changed the order

    toggle.off();
    expect(toggle.isOn()).toBe(false);
    expect(cardIds()).toEqual(original); // exact restore
  });

  it('ON -> OFF -> ON is stable across cycles', () => {
    const original = cardIds();
    const ranked = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

    toggle.on();
    expect(cardIds()).toEqual(ranked);
    toggle.off();
    expect(cardIds()).toEqual(original);
    toggle.on();
    expect(cardIds()).toEqual(ranked);
    toggle.off();
    expect(cardIds()).toEqual(original);
  });

  it('destroy() removes the pill and restores the original order', () => {
    const original = cardIds();
    toggle.on();
    toggle.destroy();

    expect(document.body.querySelector('.ml-rerank-toggle')).toBeNull();
    expect(cardIds()).toEqual(original);
  });
});

describe('toggle state persistence across pagination', () => {
  // Each test sets the persisted state it needs BEFORE mounting, so this block
  // does not mount in beforeEach. The fixture is rebuilt fresh per test.
  beforeEach(() => freshFixture());

  afterEach(() => {
    document.body.innerHTML = '';
    clearPersistedState();
  });

  it('localStorage="on" before mount -> auto-applies ON (ranked order, pill ON)', () => {
    const original = cardIds();
    const ranked = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);
    expect(original).not.toEqual(ranked); // sanity: ranking actually reorders

    localStorage.setItem(STORAGE_KEY, 'on');
    const t = mountToggle(container, createReorderer(container));

    expect(t.isOn()).toBe(true);
    expect(cardIds()).toEqual(ranked); // auto-applied ranked order
    const pill = document.body.querySelector('.ml-rerank-toggle')!;
    expect(pill.getAttribute('data-ml-rerank-state')).toBe('on');
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(pill.textContent).toContain('Re-rank: ON');
    t.destroy();
  });

  it('auto-ON at mount snapshots original order FIRST -> OFF restores ML true order', () => {
    const original = cardIds(); // ML's true served order, captured before mount
    const ranked = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

    localStorage.setItem(STORAGE_KEY, 'on');
    const t = mountToggle(container, createReorderer(container));
    expect(t.isOn()).toBe(true);
    expect(cardIds()).toEqual(ranked); // auto-applied

    t.off();
    expect(t.isOn()).toBe(false);
    expect(cardIds()).toEqual(original); // exact restore of ML's true original order
    t.destroy();
  });

  it('localStorage absent or "off" before mount -> stays OFF (default behavior)', () => {
    localStorage.removeItem(STORAGE_KEY);
    const original = cardIds();

    const t = mountToggle(container, createReorderer(container));
    expect(t.isOn()).toBe(false);
    expect(cardIds()).toEqual(original); // untouched
    t.destroy();

    localStorage.setItem(STORAGE_KEY, 'off');
    const t2 = mountToggle(container, createReorderer(container));
    expect(t2.isOn()).toBe(false);
    expect(cardIds()).toEqual(original); // still untouched
    t2.destroy();
  });

  it('toggling ON then OFF writes the corresponding values to localStorage', () => {
    localStorage.removeItem(STORAGE_KEY);
    const t = mountToggle(container, createReorderer(container));
    // OFF default at mount does NOT write (no spurious 'off' stamp on a fresh page).
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    t.on();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('on');

    t.off();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('off');
    t.destroy();
  });

  it('falls back to OFF when localStorage access throws (opaque origin / privacy mode)', () => {
    // Faithful to the jsdom opaque-origin discovery: simulate a window whose
    // localStorage accessor itself throws (opaque origin, storage disabled by
    // cookie policy, etc.) and confirm mountToggle degrades gracefully — it
    // must NEVER break the toggle, just default to in-memory OFF.
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
      const t = mountToggle(container, createReorderer(container));

      // Storage blocked -> defaults to OFF, never throws.
      expect(t.isOn()).toBe(false);

      // Toggling still works in-memory; persistence writes are swallowed.
      expect(() => t.on()).not.toThrow();
      expect(t.isOn()).toBe(true);
      expect(() => t.off()).not.toThrow();
      expect(t.isOn()).toBe(false);

      t.destroy();
    } finally {
      // Remove the own accessor so the prototype accessor jsdom installed is
      // used again by subsequent tests. (localStorage is defined on
      // Window.prototype; deleting the own shadow restores it.)
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });
});
