// PDP adapter tests (Pilar 2).
//
// IMPORTANT: these tests use SYNTHETIC minimal HTML, NOT a captured live PDP
// fixture. Live PDP capture is BLOCKED (ML bot protection; Batch 0 pending a
// human "Save Page As"). Per the spec, NO ML class selector may be frozen
// until a fixture exists, so these tests assert ONLY the fixed CONTRACT:
//   - extractDetail NEVER throws (empty/missing/lazy -> empty partial).
//   - productId is parsed from the URL (/MLM?\d+/).
//   - hydration-JSON-first path harvests review-shaped objects from
//     #__NEXT_DATA__ (generic, to be confirmed against the fixture).
//   - the DOM fallback is inert while selector constants are empty (TBD).
//   - hasMoreReviewsHint is false while the hint selector is TBD.
//
// When the real fixture lands, replace the synthetic DOMs with fixture-grounded
// assertions on the actual review container/item selectors.

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractDetail } from '../../src/adapter/ml-detail';

function dom(html: string, url = 'https://articulo.mercadolibre.com.mx/MLM123456789-titulo-falso'): Document {
  // A real ML TLD url gives jsdom a non-opaque origin (localStorage reachable).
  return new JSDOM(html, { url }).window.document;
}

describe('ml-detail adapter — fixed contract (selectors TBD)', () => {
  describe('never throws + empty fallback', () => {
    it('returns an empty partial on a blank document (never throws)', () => {
      const doc = dom('<!DOCTYPE html><html><body></body></html>');
      const data = extractDetail(doc, 'https://articulo.mercadolibre.com.mx/MLM1-x');
      expect(data.reviews).toEqual([]);
      expect(data.hasMoreReviewsHint).toBe(false);
      expect(typeof data.productId).toBe('string');
      expect(data.productId.length).toBeGreaterThan(0);
    });

    it('returns an empty partial on a document with no review markup', () => {
      const doc = dom('<html><body><h1>Producto</h1></body></html>');
      const data = extractDetail(doc);
      expect(data.reviews).toEqual([]);
      expect(data.hasMoreReviewsHint).toBe(false);
    });

    it('does not throw when location is unavailable (no global location)', () => {
      const doc = dom('<html><body></body></html>');
      expect(() => extractDetail(doc, '')).not.toThrow();
      const data = extractDetail(doc, '');
      expect(data.reviews).toEqual([]);
    });
  });

  describe('productId from URL', () => {
    it('parses MLM-prefixed ids from articulo.* URLs', () => {
      const doc = dom('<html><body></body></html>', 'https://articulo.mercadolibre.com.mx/MLM987654321-auriculares');
      expect(extractDetail(doc, 'https://articulo.mercadolibre.com.mx/MLM987654321-auriculares').productId).toBe(
        'MLM987654321',
      );
    });

    it('parses ML-prefixed ids from /p/ URLs', () => {
      const doc = dom('<html><body></body></html>', 'https://www.mercadolibre.com.ar/p/MLA555555');
      expect(extractDetail(doc, 'https://www.mercadolibre.com.ar/p/MLA555555').productId).toBe('MLA555555');
    });

    it('falls back to the pathname when no ML id is present in the URL', () => {
      const doc = dom('<html><body></body></html>', 'https://www.mercadolibre.com.mx/no-id-here');
      const data = extractDetail(doc, 'https://www.mercadolibre.com.mx/no-id-here');
      expect(data.productId.length).toBeGreaterThan(0);
    });
  });

  describe('productTitle', () => {
    it('uses the <h1> when no dedicated title selector is frozen yet', () => {
      const doc = dom('<html><body><h1>Auriculares Bluetooth</h1></body></html>');
      expect(extractDetail(doc).productTitle).toBe('Auriculares Bluetooth');
    });

    it('falls back to <title> when no <h1> exists', () => {
      const doc = dom('<html><head><title>Titulo Pagina</title></head><body></body></html>');
      expect(extractDetail(doc).productTitle).toBe('Titulo Pagina');
    });
  });

  describe('hydration-first extraction (generic Next.js #__NEXT_DATA__)', () => {
    function withNextData(json: unknown): Document {
      const script = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(json)}</script>`;
      return dom(`<html><body>${script}<h1>Producto</h1></body></html>`);
    }

    it('harvests review-shaped objects from a nested reviews array', () => {
      const doc = withNextData({
        props: {
          pageProps: {
            reviews: [
              { text: 'Excelente producto', rating: 5, date: '2025-01-02' },
              { content: 'Batería dura mucho', stars: 4 },
            ],
          },
        },
      });
      const data = extractDetail(doc, 'https://articulo.mercadolibre.com.mx/MLM123-x');
      expect(data.reviews).toHaveLength(2);
      expect(data.reviews[0].text).toBe('Excelente producto');
      expect(data.reviews[0].rating).toBe(5);
      expect(data.reviews[0].date).toBe('2025-01-02');
      expect(data.reviews[1].text).toBe('Batería dura mucho');
      expect(data.reviews[1].rating).toBe(4);
    });

    it('ignores non-review arrays (does not harvest generic objects)', () => {
      const doc = withNextData({
        items: [
          { name: 'a', price: 10 },
          { name: 'b', price: 20 },
        ],
      });
      expect(extractDetail(doc).reviews).toEqual([]);
    });

    it('returns empty when #__NEXT_DATA__ is malformed JSON', () => {
      const doc = dom(
        '<html><body><script id="__NEXT_DATA__" type="application/json">{not json</script></body></html>',
      );
      expect(extractDetail(doc).reviews).toEqual([]);
    });

    it('returns empty when there is no #__NEXT_DATA__ script', () => {
      const doc = dom('<html><body><h1>x</h1></body></html>');
      expect(extractDetail(doc).reviews).toEqual([]);
    });
  });

  describe('DOM fallback is inert while selectors are TBD (empty)', () => {
    it('does not extract reviews from arbitrary DOM (no frozen selector)', () => {
      // A page with review-looking markup but NO frozen selector should yield
      // zero reviews until selectors are filled from a fixture.
      const doc = dom(
        '<html><body><div class="some-reviews"><div class="review"><p>Muy bueno</p></div></div></body></html>',
      );
      expect(extractDetail(doc).reviews).toEqual([]);
    });
  });

  describe('hasMoreReviewsHint (provisional)', () => {
    it('is false on a page with no "ver más opiniones" control', () => {
      const doc = dom('<html><body><h1>x</h1></body></html>');
      expect(extractDetail(doc).hasMoreReviewsHint).toBe(false);
    });

    it('is true when a button labelled "ver más opiniones" exists (text heuristic)', () => {
      const doc = dom('<html><body><button>Ver más opiniones</button></body></html>');
      expect(extractDetail(doc).hasMoreReviewsHint).toBe(true);
    });
  });
});
