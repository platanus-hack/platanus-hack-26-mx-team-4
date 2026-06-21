// Reorderer tests — load the captured fixture, run the reorderer, and assert
// the cards appear in descending ranking ORDER via the CSS `order` property the
// reorderer sets (the DOM is never moved — see observe.ts for why). Reordering
// is idempotent (no repeated writes) and the MutationObserver only reacts to
// EXTERNAL card additions, never to our own style writes (no childList churn).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { findContainer, parseCards } from '../../src/adapter/mercadolibre';
import { rank } from '../../src/ranking/score';
import { RANK_CONFIG } from '../../src/config';
import type { RankConfig } from '../../src/ranking/types';
import { createReorderer, startReranking } from '../../src/observe';
import { mountToggle } from '../../src/ui/toggle';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'ml-search.html');
const html = readFileSync(fixturePath, 'utf8');

let dom: JSDOM;
let fixtureDoc: Document;
let container: HTMLElement;

function freshFixture(): void {
  // A real listing URL gives jsdom a non-opaque origin, so localStorage /
  // storage accessors (touched by some vitest matchers) don't throw.
  dom = new JSDOM(html, { url: 'https://listado.mercadolibre.com.ar/' });
  fixtureDoc = dom.window.document;
  const found = findContainer(fixtureDoc);
  expect(found).not.toBeNull();
  container = found!;
}

/** Card ids in DOM (querySelectorAll) order — the reorderer never changes this. */
function cardIds(root: ParentNode = container): string[] {
  return parseCards(root).map((c) => c.id);
}

/** The CSS `order` of a node as a number; unset (`''`) sorts last. */
function cssOrderOf(el: HTMLElement): number {
  const v = el.style.order;
  return v === '' ? Number.POSITIVE_INFINITY : Number(v);
}

/**
 * Card ids in VISUAL (applied) order: sort by the CSS `order` we set, breaking
 * ties by DOM index. When every `order` is cleared, this equals the DOM order
 * (i.e. ML's original served order).
 */
function appliedIds(root: ParentNode = container): string[] {
  return parseCards(root)
    .map((c, i) => ({ id: c.id, order: cssOrderOf(c.nodeRef as HTMLElement), i }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((x) => x.id);
}

describe('reorderer — fixture-grounded', () => {
  beforeEach(() => freshFixture());

  describe('reorder (synchronous, no observer)', () => {
    it('assigns style.order so cards appear in descending ranking order (no DOM move)', () => {
      const originalDom = cardIds();
      const expectedRankedIds = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

      createReorderer(container).reorder();

      expect(appliedIds()).toEqual(expectedRankedIds); // visual order = ranked
      expect(cardIds()).toEqual(originalDom); // DOM order untouched
    });

    it('does NOT move DOM nodes (same refs, same DOM positions)', () => {
      const before = parseCards(container).map((c) => c.nodeRef);
      createReorderer(container).reorder();
      const after = parseCards(container).map((c) => c.nodeRef);

      expect(after).toHaveLength(before.length);
      for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    });

    it('keeps all 60 cards (no loss, no duplication)', () => {
      createReorderer(container).reorder();
      const after = parseCards(container);
      expect(after).toHaveLength(60);
      expect(new Set(after.map((c) => c.nodeRef)).size).toBe(60);
    });

    it('tags every card row with data-ml-reranked="1"', () => {
      createReorderer(container).reorder();
      const rows = Array.from(container.querySelectorAll('li.ui-search-layout__item'));
      expect(rows.length).toBe(60);
      for (const row of rows) expect(row.getAttribute('data-ml-reranked')).toBe('1');
    });

    it('is idempotent: a second run writes no new order values', () => {
      const reorderer = createReorderer(container);
      reorderer.reorder();
      const orderAfterFirst = appliedIds();
      const stylesAfterFirst = parseCards(container).map((c) => (c.nodeRef as HTMLElement).style.order);

      reorderer.reorder();

      expect(appliedIds()).toEqual(orderAfterFirst);
      const stylesAfterSecond = parseCards(container).map((c) => (c.nodeRef as HTMLElement).style.order);
      expect(stylesAfterSecond).toEqual(stylesAfterFirst);
    });

    it('is a no-op on an empty container', () => {
      const empty = fixtureDoc.createElement('ol');
      empty.classList.add('ui-search-layout');
      const reorderer = createReorderer(empty);
      expect(() => reorderer.reorder()).not.toThrow();
      expect(parseCards(empty)).toEqual([]);
    });
  });

  describe('MutationObserver — loop avoidance', () => {
    afterEach(() => vi.useRealTimers());

    it('does not loop on its own writes (style changes never touch childList)', async () => {
      vi.useFakeTimers();
      const expectedRankedIds = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

      const reorderer = createReorderer(container);
      reorderer.start();
      reorderer.reorder(); // sets style.order only -> NO childList mutation -> observer idle

      // Flush the observer microtask + the 250ms debounce. With no node moves
      // there is nothing for the childList observer to react to, so no runaway.
      await vi.advanceTimersByTimeAsync(300);

      const after = parseCards(container);
      expect(after).toHaveLength(60);
      expect(appliedIds()).toEqual(expectedRankedIds);

      reorderer.destroy();
    });

    it('re-ranks when an external card is added (Ver mas simulation)', async () => {
      vi.useFakeTimers();
      const reorderer = createReorderer(container);
      reorderer.start();
      reorderer.reorder();
      await vi.advanceTimersByTimeAsync(300); // settle initial reorder

      // Simulate "Ver mas": append a NEW card row (deep clone of an existing one
      // so the adapter can parse its signals). Clear any copied order so it
      // starts unranked.
      const clone = container
        .querySelector('li.ui-search-layout__item')!
        .cloneNode(true) as HTMLElement;
      clone.style.order = '';
      container.appendChild(clone);

      await vi.advanceTimersByTimeAsync(300); // observer -> debounced reorder

      const after = parseCards(container);
      expect(after).toHaveLength(61); // new card incorporated, not duplicated
      expect(new Set(after.map((c) => c.nodeRef)).size).toBe(61);
      // The new card was folded into the ranking (it received an order value).
      expect(clone.style.order).not.toBe('');

      reorderer.destroy();
    });

    it('startReranking creates a controller that is already observing', async () => {
      vi.useFakeTimers();
      const reorderer = startReranking(container);
      reorderer.reorder();
      await vi.advanceTimersByTimeAsync(300);
      expect(parseCards(container)).toHaveLength(60);
      reorderer.destroy();
    });

    it('stop() halts observation: a later external add is NOT re-ranked', async () => {
      vi.useFakeTimers();
      const reorderer = createReorderer(container);
      reorderer.start();
      reorderer.reorder();
      await vi.advanceTimersByTimeAsync(300); // settle
      reorderer.stop();

      const clone = container
        .querySelector('li.ui-search-layout__item')!
        .cloneNode(true) as HTMLElement;
      clone.style.order = '';
      container.appendChild(clone);
      await vi.advanceTimersByTimeAsync(300); // would re-rank if still observing

      // Observer stopped -> reorder never ran -> the clone never got an order.
      expect(clone.style.order).toBe('');
      const rows = Array.from(container.querySelectorAll('li.ui-search-layout__item'));
      expect(rows).toHaveLength(61);
      expect(rows[rows.length - 1]).toBe(clone); // still last in DOM (never moved)

      reorderer.destroy();
    });
  });
});

// Phase 4 — RerankController.updateConfig: re-apply order to the CURRENT DOM
// with a new config using the existing pipeline, with ZERO network calls. The
// toggle owns the observe lifecycle, so updateConfig must NOT start/stop the
// observer. Idempotency is preserved (a no-op when the order is already applied).
describe('updateConfig — zero-network re-rank of current DOM', () => {
  // A config that emphasizes price strongly and drops the sponsored penalty,
  // producing an order distinct from the default RANK_CONFIG on the fixture.
  const PRICE_HEAVY: RankConfig = { w1: 0.05, w2: 2.0, w3: 0.0, w4: 0.05, priorC: 5 };

  beforeEach(() => freshFixture());
  afterEach(() => vi.useRealTimers());

  it('createReorderer(container) with no config still defaults to RANK_CONFIG (backward compatible)', () => {
    const expected = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);
    createReorderer(container).reorder();
    expect(appliedIds()).toEqual(expected);
  });

  it('updateConfig(next) re-applies order with the new config (weight change reorders)', () => {
    const defaultOrder = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);
    const reorderer = createReorderer(container);
    reorderer.reorder();
    expect(appliedIds()).toEqual(defaultOrder);

    // The DOM order never changes, so parseCards always sees ML's original order
    // (the rank originalIndex tie-break is therefore stable across configs).
    const expectedAfterUpdate = rank(parseCards(container), PRICE_HEAVY).map((c) => c.id);
    expect(expectedAfterUpdate).not.toEqual(defaultOrder); // sanity: weight change reorders

    reorderer.updateConfig(PRICE_HEAVY);
    expect(appliedIds()).toEqual(expectedAfterUpdate);
  });

  it('updateConfig merges defaults for missing fields (partial config)', () => {
    const partial = { w4: 1.5 } as RankConfig;
    const merged: RankConfig = { ...RANK_CONFIG, w4: 1.5 };
    const expected = rank(parseCards(container), merged).map((c) => c.id);

    const reorderer = createReorderer(container);
    reorderer.updateConfig(partial);
    expect(appliedIds()).toEqual(expected);
  });

  it('updateConfig makes ZERO network calls (Pilar 1 no-network invariant)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const reorderer = createReorderer(container);
      reorderer.reorder();
      reorderer.updateConfig(PRICE_HEAVY);
      reorderer.updateConfig(RANK_CONFIG);
      reorderer.updateConfig({ w1: 1.0, w2: 0.1, w3: 0.4, w4: 0.1, priorC: 5 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('updateConfig is idempotent: applying the same config twice writes nothing the second time', () => {
    const reorderer = createReorderer(container);
    reorderer.updateConfig(PRICE_HEAVY);
    const afterFirst = appliedIds();

    reorderer.updateConfig(PRICE_HEAVY);
    expect(appliedIds()).toEqual(afterFirst);
    expect(parseCards(container)).toHaveLength(60);
  });

  it('updateConfig does NOT start the observer (a not-started controller stays not-observing)', async () => {
    vi.useFakeTimers();
    const reorderer = createReorderer(container); // not started
    reorderer.updateConfig(PRICE_HEAVY); // applies order once, synchronously

    const originalRows = Array.from(container.children) as HTMLElement[];
    const ordersBefore = originalRows.map((r) => r.style.order);

    // Append a fresh card. Since the observer was never started, no debounced
    // re-rank should run, even after the debounce window elapses.
    const clone = container.querySelector('li.ui-search-layout__item')!.cloneNode(true) as HTMLElement;
    clone.style.order = '';
    container.appendChild(clone);
    await vi.advanceTimersByTimeAsync(400);

    // Observer never started -> the clone never got an order...
    expect(clone.style.order).toBe('');
    // ...and the original rows keep their updateConfig order untouched.
    originalRows.forEach((r, i) => expect(r.style.order).toBe(ordersBefore[i]));
  });

  it('updateConfig does NOT stop a running observer (external adds still re-rank)', async () => {
    vi.useFakeTimers();
    const reorderer = createReorderer(container);
    reorderer.start();
    reorderer.reorder();
    await vi.advanceTimersByTimeAsync(300); // settle initial reorder

    reorderer.updateConfig(PRICE_HEAVY); // re-rank with new config; must NOT stop observer
    await vi.advanceTimersByTimeAsync(300); // settle the updateConfig reorder

    // External add -> observer still alive -> re-ranks (clone gets an order).
    const clone = container.querySelector('li.ui-search-layout__item')!.cloneNode(true) as HTMLElement;
    clone.style.order = '';
    container.appendChild(clone); // appended last in DOM
    await vi.advanceTimersByTimeAsync(400); // observer -> debounced reorder

    const after = parseCards(container);
    expect(after).toHaveLength(61);
    expect(new Set(after.map((c) => c.nodeRef)).size).toBe(61);
    // The clone was folded into the ranking -> observer ran -> not stopped.
    expect(clone.style.order).not.toBe('');

    reorderer.destroy();
  });
});

// Phase 6.1 — cross-cutting invariant (spec: "Toggle restore remains exact"):
// a prefs-driven re-rank (updateConfig) must NOT corrupt the toggle's restore.
// Turning the toggle OFF after a config change still restores the EXACT
// MercadoLibre-served order. Restore is just clearing the CSS `order` the
// reorderer set (the DOM was never moved), so it is structurally exact.
describe('cross-cutting: toggle OFF restores exact order after prefs-driven reorder (Phase 6.1)', () => {
  const PRICE_HEAVY: RankConfig = { w1: 0.05, w2: 2.0, w3: 0.0, w4: 0.05, priorC: 5 };

  beforeEach(() => freshFixture());

  afterEach(() => {
    document.body.innerHTML = '';
    try {
      localStorage.removeItem('ml-rerank:enabled');
    } catch {
      // storage blocked in this test — nothing to clear
    }
  });

  it('toggle OFF restores the EXACT original ML order after updateConfig re-ranks the DOM', () => {
    const original = cardIds(); // ML's true served order (DOM order, never changes)

    const reorderer = createReorderer(container);
    const toggle = mountToggle(container, reorderer);

    // ON -> ranked order (distinct from original).
    toggle.on();
    const onOrder = appliedIds();
    expect(onOrder).not.toEqual(original);

    // Prefs-driven re-rank with a new config.
    const expectedAfterUpdate = rank(parseCards(container), PRICE_HEAVY).map((c) => c.id);
    expect(expectedAfterUpdate).not.toEqual(onOrder); // sanity: config change reorders
    reorderer.updateConfig(PRICE_HEAVY);
    expect(appliedIds()).toEqual(expectedAfterUpdate);

    // OFF clears the order -> visual order returns to ML's true served order.
    toggle.off();
    expect(appliedIds()).toEqual(original);
    expect(cardIds()).toEqual(original);

    toggle.destroy();
  });

  it('repeated prefs changes + ON/OFF cycles always restore the exact original order', () => {
    const original = cardIds();
    const reorderer = createReorderer(container);
    const toggle = mountToggle(container, reorderer);

    toggle.on();
    reorderer.updateConfig(PRICE_HEAVY);
    reorderer.updateConfig(RANK_CONFIG);
    reorderer.updateConfig({ w1: 1.0, w2: 0.1, w3: 0.4, w4: 0.1, priorC: 5 });
    toggle.off();
    expect(appliedIds()).toEqual(original);

    // A second cycle after several config swaps still restores exactly.
    toggle.on();
    reorderer.updateConfig(PRICE_HEAVY);
    toggle.off();
    expect(appliedIds()).toEqual(original);

    toggle.destroy();
  });
});
