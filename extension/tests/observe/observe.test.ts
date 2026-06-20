// Reorderer tests — load the captured fixture, run the reorderer, and assert
// the cards appear in descending ranking order and that reordering is
// idempotent (no duplicate nodes / no observer loop). The MutationObserver
// loop path is exercised with fake timers; per the task brief, a guard-flag +
// no-loop assertion is sufficient (full async loop coverage is manual).

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

function cardIds(root: ParentNode = container): string[] {
  return parseCards(root).map((c) => c.id);
}

describe('reorderer — fixture-grounded', () => {
  beforeEach(() => freshFixture());

  describe('reorder (synchronous, no observer)', () => {
    it('re-appends the existing card nodes into descending ranking order', () => {
      const expectedRankedIds = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

      createReorderer(container).reorder();

      expect(cardIds()).toEqual(expectedRankedIds);
    });

    it('moves the SAME node references (in-place, no clone)', () => {
      const before = parseCards(container).map((c) => c.nodeRef);
      createReorderer(container).reorder();
      const after = parseCards(container).map((c) => c.nodeRef);

      expect(after).toHaveLength(before.length);
      expect(new Set(after).size).toBe(before.length);
      // Reference equality (Set.has uses ===). Avoids vitest's deep-equality
      // walker on DOM nodes, which trips jsdom's opaque-origin localStorage.
      const beforeSet = new Set(before);
      for (const node of after) expect(beforeSet.has(node)).toBe(true);
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

    it('is idempotent: a second run with the same ranking leaves the DOM unchanged', () => {
      const reorderer = createReorderer(container);
      reorderer.reorder();
      const orderAfterFirst = cardIds();

      reorderer.reorder();
      const orderAfterSecond = cardIds();

      expect(orderAfterSecond).toEqual(orderAfterFirst);
      expect(parseCards(container)).toHaveLength(60);
      expect(new Set(orderAfterSecond).size).toBe(60);
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

    it('does not loop on its own re-append writes (guard + tag-skip + idempotency)', async () => {
      vi.useFakeTimers();
      const expectedRankedIds = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

      const reorderer = createReorderer(container);
      reorderer.start();
      reorderer.reorder(); // writes -> queues a childList mutation

      // Flush the observer microtask + the 250ms debounce window. If the guard
      // failed, our own writes would schedule a reorder that writes again ->
      // runaway. Idempotency + tag-skip make the callback a no-op instead.
      await vi.advanceTimersByTimeAsync(300);

      const after = parseCards(container);
      expect(after).toHaveLength(60);
      expect(new Set(after.map((c) => c.nodeRef)).size).toBe(60);
      expect(cardIds()).toEqual(expectedRankedIds);

      reorderer.destroy();
    });

    it('re-ranks when an external untagged card is added (Ver mas simulation)', async () => {
      vi.useFakeTimers();
      const reorderer = createReorderer(container);
      reorderer.start();
      reorderer.reorder();
      await vi.advanceTimersByTimeAsync(300); // settle initial reorder

      // Simulate "Ver mas": append a NEW untagged card row (deep clone of an
      // existing one so the adapter can still parse its signals).
      const clone = container
        .querySelector('li.ui-search-layout__item')!
        .cloneNode(true) as HTMLElement;
      container.appendChild(clone);

      await vi.advanceTimersByTimeAsync(300); // observer -> debounced reorder

      const after = parseCards(container);
      expect(after).toHaveLength(61); // new card incorporated, not duplicated
      expect(new Set(after.map((c) => c.nodeRef)).size).toBe(61);

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
      container.appendChild(clone);
      await vi.advanceTimersByTimeAsync(300); // would re-rank if still observing

      const rows = Array.from(container.querySelectorAll('li.ui-search-layout__item'));
      // Observer stopped -> no reorder ran -> the clone stays where we put it
      // (last), instead of being moved to its ranked position.
      expect(rows).toHaveLength(61);
      expect(rows[rows.length - 1]).toBe(clone);

      reorderer.destroy();
    });
  });
});

// Phase 4 — RerankController.updateConfig: re-rank the CURRENT DOM with a new
// config using the existing reorder pipeline, with ZERO network calls. The
// toggle owns the observe lifecycle, so updateConfig must NOT start/stop the
// observer. Idempotency is preserved (a no-op when the DOM is already ranked).
describe('updateConfig — zero-network re-rank of current DOM', () => {
  // A config that emphasizes price strongly and drops the sponsored penalty,
  // producing an order distinct from the default RANK_CONFIG on the fixture.
  const PRICE_HEAVY: RankConfig = { w1: 0.05, w2: 2.0, w3: 0.0, w4: 0.05, priorC: 5 };

  beforeEach(() => freshFixture());
  afterEach(() => vi.useRealTimers());

  it('createReorderer(container) with no config still defaults to RANK_CONFIG (backward compatible)', () => {
    const expected = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);
    createReorderer(container).reorder();
    expect(cardIds()).toEqual(expected);
  });

  it('updateConfig(next) re-ranks the CURRENT DOM with the new config (weight change reorders)', () => {
    const defaultOrder = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);
    const reorderer = createReorderer(container);
    reorderer.reorder();
    expect(cardIds()).toEqual(defaultOrder);

    // Compute the expected PRICE_HEAVY order from the CURRENT DOM (i.e. after the
    // default reorder), exactly as updateConfig will. rank() is order-sensitive
    // only via the originalIndex tie-break, so the expected must be derived from
    // the same input order the implementation sees at updateConfig time.
    const expectedAfterUpdate = rank(parseCards(container), PRICE_HEAVY).map((c) => c.id);
    expect(expectedAfterUpdate).not.toEqual(defaultOrder); // sanity: weight change reorders

    reorderer.updateConfig(PRICE_HEAVY);
    expect(cardIds()).toEqual(expectedAfterUpdate); // re-ranked with the new config
  });

  it('updateConfig merges defaults for missing fields (partial config)', () => {
    // Only w4 overridden; the rest must come from RANK_CONFIG defaults.
    const partial = { w4: 1.5 } as RankConfig;
    const merged: RankConfig = { ...RANK_CONFIG, w4: 1.5 };
    const expected = rank(parseCards(container), merged).map((c) => c.id);

    const reorderer = createReorderer(container);
    reorderer.updateConfig(partial);
    expect(cardIds()).toEqual(expected);
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
    const afterFirst = cardIds();

    reorderer.updateConfig(PRICE_HEAVY);
    expect(cardIds()).toEqual(afterFirst);
    expect(parseCards(container)).toHaveLength(60);
  });

  it('updateConfig does NOT start the observer (a not-started controller stays not-observing)', async () => {
    vi.useFakeTimers();
    const reorderer = createReorderer(container); // not started
    reorderer.updateConfig(PRICE_HEAVY); // re-ranks once, synchronously
    const nodesBefore = parseCards(container).map((c) => c.nodeRef); // 60 in PRICE_HEAVY order

    // Append an untagged card. Since the observer was never started, no
    // debounced re-rank should run, even after the debounce window elapses.
    // (Strip the inherited data-ml-reranked tag so this is a true external add,
    // not a self-re-append the observer would skip.)
    const clone = container.querySelector('li.ui-search-layout__item')!.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-ml-reranked');
    container.appendChild(clone);
    await vi.advanceTimersByTimeAsync(400);

    const rows = Array.from(container.querySelectorAll('li.ui-search-layout__item'));
    expect(rows).toHaveLength(61);
    // Observer never started -> the clone stays where we put it (last)...
    expect(rows[rows.length - 1]).toBe(clone);
    // ...and the original 60 keep their updateConfig order untouched (ref-equal,
    // index-for-index; avoids vitest deep-equality on DOM nodes).
    expect(rows.slice(0, 60).length).toBe(nodesBefore.length);
    for (let i = 0; i < nodesBefore.length; i++) {
      expect(rows[i]).toBe(nodesBefore[i]);
    }
  });

  it('updateConfig does NOT stop a running observer (external adds still re-rank)', async () => {
    vi.useFakeTimers();
    const reorderer = createReorderer(container);
    reorderer.start();
    reorderer.reorder();
    await vi.advanceTimersByTimeAsync(300); // settle initial reorder

    reorderer.updateConfig(PRICE_HEAVY); // re-rank with new config; must NOT stop observer
    await vi.advanceTimersByTimeAsync(300); // settle the updateConfig reorder

    // External untagged add -> observer still alive -> re-ranks (clone moves).
    // (Strip the inherited tag so the observer treats the clone as external.)
    const clone = container.querySelector('li.ui-search-layout__item')!.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-ml-reranked');
    container.appendChild(clone); // appended last
    await vi.advanceTimersByTimeAsync(400); // observer -> debounced reorder

    const after = parseCards(container);
    expect(after).toHaveLength(61);
    expect(new Set(after.map((c) => c.nodeRef)).size).toBe(61);
    const rows = Array.from(container.querySelectorAll('li.ui-search-layout__item'));
    // The clone was re-ranked off the last position -> observer ran -> not stopped.
    expect(rows[rows.length - 1]).not.toBe(clone);

    reorderer.destroy();
  });
});
