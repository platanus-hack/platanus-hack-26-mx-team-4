// PDP adapter tests (Pilar 2).
//
// Selectors are FROZEN against a CAPTURED live PDP fixture
// (tests/fixtures/ml-pdp-ar.html — a real ML product page saved via browser
// "Save Page As"). The fixture is the contract: selectors that do not resolve
// against it are wrong by definition (mirrors tests/adapter/mercadolibre.test.ts
// from Pilar 1).
//
// Two layers are covered:
//   1. Fixture-grounded extraction — the real `ui-review-capability` review
//      markup (featured reviews rendered inline; rating as filled star SVGs).
//   2. The fixed CONTRACT — extractDetail NEVER throws (empty/missing -> empty
//      partial), productId parsed from the URL, hydration-first `#__NEXT_DATA__`
//      path for Next.js-style pages, title/<h1>/<title> fallbacks.

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { extractDetail } from '../../src/adapter/ml-detail';

function dom(html: string, url = 'https://articulo.mercadolibre.com.mx/MLM123456789-titulo-falso'): Document {
  // A real ML TLD url gives jsdom a non-opaque origin (localStorage reachable).
  return new JSDOM(html, { url }).window.document;
}

// ---------------------------------------------------------------------------
// Captured live PDP fixture (saved from a real ML MX product page). Parsed once.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'ml-pdp-ar.html');
const fixtureHtml = readFileSync(fixturePath, 'utf8');
const fixtureUrl =
  'https://www.mercadolibre.com.mx/auriculares-inalambricos-xiaomi-redmi-buds-6-play-negro/p/MLM39962085#reviews';

describe('ml-detail adapter — fixture-grounded (ml-pdp-ar.html)', () => {
  let data: ReturnType<typeof extractDetail>;

  beforeAll(() => {
    const doc = new JSDOM(fixtureHtml, { url: fixtureUrl }).window.document;
    data = extractDetail(doc, fixtureUrl);
  });

  it('parses the product id from the /p/ URL', () => {
    expect(data.productId).toBe('MLM39962085');
  });

  it('parses the product title from .ui-pdp-title', () => {
    expect(data.productTitle).toBe('Auriculares Inalámbricos Xiaomi Redmi Buds 6 Play Negro');
  });

  it('extracts exactly the 5 featured reviews rendered inline', () => {
    expect(data.reviews).toHaveLength(5);
  });

  it('extracts the body text of each review (non-empty)', () => {
    for (const r of data.reviews) {
      expect(typeof r.text).toBe('string');
      expect(r.text.length).toBeGreaterThan(0);
    }
    expect(data.reviews[0].text.startsWith('Nashe god')).toBe(true);
  });

  it('counts filled star SVGs into a 1..5 numeric rating', () => {
    for (const r of data.reviews) {
      expect(r.rating).not.toBeNull();
      expect(r.rating!).toBeGreaterThanOrEqual(1);
      expect(r.rating!).toBeLessThanOrEqual(5);
    }
    // The 5 featured reviews in this fixture are all 5-star.
    expect(data.reviews[0].rating).toBe(5);
  });

  it('attaches NO date (ML\'s __date element holds the country, not a date)', () => {
    for (const r of data.reviews) expect(r.date).toBeUndefined();
  });

  it('detects the "Mostrar todas las opiniones" control (hasMoreReviewsHint)', () => {
    expect(data.hasMoreReviewsHint).toBe(true);
  });
});

describe('ml-detail adapter — fixed contract', () => {
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
    it('uses the <h1> when no .ui-pdp-title is present', () => {
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

  describe('DOM extraction is selector-scoped (frozen selectors)', () => {
    it('does not extract reviews from arbitrary review-looking markup', () => {
      // Markup with generic class names (not the frozen ui-review-capability
      // selectors) must yield zero reviews.
      const doc = dom(
        '<html><body><div class="some-reviews"><div class="review"><p>Muy bueno</p></div></div></body></html>',
      );
      expect(extractDetail(doc).reviews).toEqual([]);
    });

    it('extracts a review from the frozen ui-review-capability markup', () => {
      const doc = dom(
        '<html><body><div class="ui-review-capability-comments">' +
          '<article class="ui-review-capability-comments__comment">' +
          '<div class="ui-review-capability-comments__comment__rating">' +
          '<svg class="ui-review-capability-comments__comment__rating__star"><use href="#poly_star_fill"></use></svg>' +
          '<svg class="ui-review-capability-comments__comment__rating__star"><use href="#poly_star_fill"></use></svg>' +
          '<svg class="ui-review-capability-comments__comment__rating__star"><use href="#poly_star_fill"></use></svg>' +
          '<svg class="ui-review-capability-comments__comment__rating__star"><use href="#poly_star_empty"></use></svg>' +
          '<svg class="ui-review-capability-comments__comment__rating__star"><use href="#poly_star_empty"></use></svg>' +
          '</div>' +
          '<p class="ui-review-capability-comments__comment__content">Buen producto</p>' +
          '</article></div></body></html>',
      );
      const reviews = extractDetail(doc).reviews;
      expect(reviews).toHaveLength(1);
      expect(reviews[0].text).toBe('Buen producto');
      expect(reviews[0].rating).toBe(3);
    });
  });

  describe('hasMoreReviewsHint (frozen .show-more-click control)', () => {
    it('is false on a page with no review control', () => {
      const doc = dom('<html><body><h1>x</h1></body></html>');
      expect(extractDetail(doc).hasMoreReviewsHint).toBe(false);
    });

    it('is true when the "Mostrar todas las opiniones" control (.show-more-click) exists', () => {
      const doc = dom('<html><body><button class="show-more-click">Mostrar todas las opiniones</button></body></html>');
      expect(extractDetail(doc).hasMoreReviewsHint).toBe(true);
    });
  });
});
