// Adapter tests — ground every selector in the CAPTURED live fixture
// (tests/fixtures/ml-search.html). The fixture is the contract; selectors that
// do not resolve against it are wrong by definition.
//
// Strict TDD: these tests are written BEFORE the adapter implementation (RED),
// then the adapter is implemented to satisfy them (GREEN).

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { findContainer, parseCards } from '../../src/adapter/mercadolibre';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'ml-search.html');

// The fixture is a full captured MercadoLibre search page (~2.3 MB). We parse it
// once into a JSDOM instance and pass its `document` to the adapter so tests stay
// isolated from Vitest's global jsdom document.
const html = readFileSync(fixturePath, 'utf8');
const dom = new JSDOM(html);
const fixtureDoc = dom.window.document;

// First listing card (sponsored Anker Soundcore P20i). Values verified against
// the fixture: rating 4.8, "+50mil vendidos" -> 50000, current price $449,01.
const FIRST_CARD = { rating: 4.8, reviewCount: 50000, price: 449.01 } as const;

describe('mercadolibre adapter — fixture-grounded', () => {
  describe('findContainer', () => {
    it('returns the search results <ol> container', () => {
      const container = findContainer(fixtureDoc);
      expect(container).not.toBeNull();
      expect(container!.tagName).toBe('OL');
      expect(container!.classList.contains('ui-search-layout')).toBe(true);
    });

    it('returns null when no results container exists', () => {
      const empty = new JSDOM('<!DOCTYPE html><html><body></body></html>').window.document;
      expect(findContainer(empty)).toBeNull();
    });

    it('defaults to the global document when no argument is given', () => {
      // Production calls findContainer() with no arg; it must use the global
      // document. Smoke-test the default-arg path returns null on the empty
      // Vitest global document (no ML markup present here).
      expect(findContainer()).toBeNull();
    });
  });

  describe('parseCards', () => {
    let cards: ReturnType<typeof parseCards>;

    beforeAll(() => {
      const container = findContainer(fixtureDoc);
      expect(container).not.toBeNull();
      cards = parseCards(container!);
    });

    it('parses exactly the 60 listing cards present in the fixture', () => {
      expect(cards).toHaveLength(60);
    });

    it('every nodeRef is the <li> card row (the reorderer re-appends these)', () => {
      for (const card of cards) {
        expect(card.nodeRef).toBeInstanceOf(fixtureDoc.defaultView!.HTMLElement);
        expect(card.nodeRef.tagName).toBe('LI');
        expect(card.nodeRef.classList.contains('ui-search-layout__item')).toBe(true);
      }
    });

    it('every card has a non-empty unique id (title href)', () => {
      const ids = cards.map((c) => c.id);
      for (const id of ids) expect(typeof id === 'string' && id.length > 0).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('parses the first (sponsored) card signals exactly', () => {
      const first = cards[0];
      expect(first.sponsored).toBe(true);
      expect(first.rating).toBeCloseTo(FIRST_CARD.rating, 5);
      expect(first.reviewCount).toBe(FIRST_CARD.reviewCount);
      expect(first.price).toBeCloseTo(FIRST_CARD.price, 2);
    });

    it('flags exactly 12 sponsored cards ("Promocionado" badge)', () => {
      const sponsored = cards.filter((c) => c.sponsored);
      expect(sponsored).toHaveLength(12);
    });

    it('all sponsored cards are disjoint from organic cards', () => {
      const organic = cards.filter((c) => !c.sponsored);
      expect(organic).toHaveLength(48);
      expect(organic.every((c) => c.sponsored === false)).toBe(true);
    });

    it('parses the "vendidos" sold-count into a numeric reliability signal, including the "mil" multiplier', () => {
      // The fixture exposes sold counts ("+Nmil vendidos" / "+N vendidos"), not
      // "(123)" review counts. The adapter maps this to reviewCount.
      const counts = cards.map((c) => c.reviewCount ?? 0);
      for (const c of counts) expect(Number.isFinite(c) && c >= 0).toBe(true);
      // "+1000 vendidos" cards exist in the fixture -> 1000.
      expect(counts).toContain(1000);
      // "+10mil vendidos" -> 10000 (mil multiplier).
      expect(counts).toContain(10000);
      // first card "+50mil vendidos" -> 50000.
      expect(cards[0].reviewCount).toBe(50000);
    });

    it('parses ratings as finite numbers in 0..5 when present', () => {
      const rated = cards.filter((c) => c.rating != null);
      expect(rated.length).toBeGreaterThan(0);
      for (const c of rated) {
        expect(Number.isFinite(c.rating)).toBe(true);
        expect(c.rating).toBeGreaterThanOrEqual(0);
        expect(c.rating!).toBeLessThanOrEqual(5);
      }
    });

    it('reports rating=null and reviewCount=0 for cards with no rating block', () => {
      // 4 of the 60 fixture cards have no .poly-component__review-compacted.
      const unrated = cards.filter((c) => c.rating === null);
      expect(unrated.length).toBe(4);
      for (const c of unrated) expect(c.reviewCount).toBe(0);
    });

    it('parses a finite, positive current (non-previous) price for every card', () => {
      for (const c of cards) {
        expect(c.price).not.toBeNull();
        expect(Number.isFinite(c.price)).toBe(true);
        expect(c.price!).toBeGreaterThan(0);
      }
    });

    it('uses the discounted current price, not the struck-through previous price (first card: 449.01 not 649)', () => {
      expect(cards[0].price).toBeCloseTo(449.01, 2);
      expect(cards[0].price!).toBeLessThan(649);
    });

    it('produces no NaN anywhere in the parsed output', () => {
      for (const c of cards) {
        if (c.rating != null) expect(Number.isNaN(c.rating)).toBe(false);
        if (c.reviewCount != null) expect(Number.isNaN(c.reviewCount)).toBe(false);
        if (c.price != null) expect(Number.isNaN(c.price)).toBe(false);
      }
    });

    it('parses freeShipping as a boolean and detects the "gratis" shipping pills', () => {
      for (const c of cards) expect(typeof c.freeShipping).toBe('boolean');
      // The fixture renders "Llega gratis ..." pills on many cards.
      expect(cards.some((c) => c.freeShipping === true)).toBe(true);
    });

    it('parses full as a boolean and detects the "Enviado por FULL" badge', () => {
      for (const c of cards) expect(typeof c.full).toBe('boolean');
      // The fixture renders the Mercado Envíos Full badge on many cards.
      expect(cards.some((c) => c.full === true)).toBe(true);
    });

    it('parses discount as a 0..1 fraction; the first card is ~0.31 off (649 -> 449.01)', () => {
      for (const c of cards) {
        expect(typeof c.discount).toBe('number');
        expect(c.discount!).toBeGreaterThanOrEqual(0);
        expect(c.discount!).toBeLessThanOrEqual(1);
      }
      expect(cards[0].discount!).toBeCloseTo((649 - 449.01) / 649, 4);
    });

    it('reports discount=0 for cards without a struck previous price', () => {
      // A card whose price has no `--previous` amount must not fabricate a discount.
      const noDiscount = cards.filter((c) => c.discount === 0);
      expect(noDiscount.length).toBeGreaterThan(0);
    });

    it('returns [] for an empty container', () => {
      const empty = fixtureDoc.createElement('ol');
      expect(parseCards(empty)).toEqual([]);
    });

    it('skips list items that contain no .poly-card without throwing', () => {
      const ol = fixtureDoc.createElement('ol');
      ol.classList.add('ui-search-layout');
      const li = fixtureDoc.createElement('li');
      li.classList.add('ui-search-layout__item');
      // no .poly-card inside
      ol.appendChild(li);
      expect(parseCards(ol)).toEqual([]);
    });
  });
});
