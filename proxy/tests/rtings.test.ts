// RTINGS adapter unit tests. Uses the REAL captured review page
// (tests/fixtures/rtings-headphones.html — JLab Audio GO Air POP True Wireless)
// for parseReviewPage, and a mocked fetch for the search + orchestration flow.
// No live network.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  normalizeText,
  significantTokens,
  matchConfidence,
  looksLikeHeadphones,
  buildSearchUrl,
  parseSearchResults,
  parseSearchApiResults,
  parseReviewPage,
  decodeEntities,
  fetchAnalysis,
  RTINGS_MATCH_THRESHOLD,
  type ProductQuery,
} from '../api/sources/rtings';

const here = dirname(fileURLToPath(import.meta.url));
const REVIEW_HTML = readFileSync(join(here, 'fixtures', 'rtings-headphones.html'), 'utf8');

// The real product behind the fixture.
const JLAB: ProductQuery = {
  brand: 'JLab',
  model: 'Go Air Pop',
  title: 'Audífonos JLab Go Air Pop Inalámbricos Bluetooth Negro',
};

describe('normalizeText / significantTokens', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(normalizeText('Audífonos JLab GO-Air, POP!')).toBe('audifonos jlab go air pop');
  });
  it('drops stopwords (category / connectivity / colors / "audio")', () => {
    expect(significantTokens('Audífonos JLab Audio Go Air Pop Inalámbricos Bluetooth Negro')).toEqual([
      'jlab',
      'go',
      'air',
      'pop',
    ]);
  });
  it('drops MercadoLibre seller boilerplate that is not part of the model', () => {
    expect(significantTokens('Apple AirPods Pro 3 Color Blanco Con CancelaciÃ³n De Ruido Distribuidor Autorizado')).toEqual([
      'apple',
      'airpods',
      'pro',
      '3',
    ]);
  });
});

describe('matchConfidence — conservative Jaccard', () => {
  it('scores the exact product at/above the threshold', () => {
    const score = matchConfidence(JLAB, 'JLab Audio GO Air POP True Wireless');
    expect(score).toBeGreaterThanOrEqual(RTINGS_MATCH_THRESHOLD);
  });
  it('scores a DIFFERENT model below the threshold (no false positive)', () => {
    const score = matchConfidence(JLAB, 'JLab Go Air ANC True Wireless');
    expect(score).toBeLessThan(RTINGS_MATCH_THRESHOLD);
  });
  it('returns 0 when there are no shared tokens', () => {
    expect(matchConfidence(JLAB, 'Sony WH-1000XM5 Wireless')).toBe(0);
  });
});

describe('looksLikeHeadphones — scope gate', () => {
  it('accepts headphone-ish ML titles', () => {
    expect(looksLikeHeadphones({ title: 'Audífonos JLab Go Air Pop' })).toBe(true);
    expect(looksLikeHeadphones({ title: 'Sony Wireless Earbuds WF-1000XM4' })).toBe(true);
  });
  it('rejects non-headphone products', () => {
    expect(looksLikeHeadphones({ title: 'Licuadora Oster 10 velocidades' })).toBe(false);
  });
});

describe('decodeEntities', () => {
  it('decodes named + numeric entities', () => {
    expect(decodeEntities('A&amp;B &quot;x&quot; &#39;y&#39; &nbsp;z')).toBe('A&B "x" \'y\'  z');
  });
});

describe('buildSearchUrl', () => {
  it('uses brand + model and URL-encodes the query', () => {
    expect(buildSearchUrl(JLAB)).toBe('https://www.rtings.com/search?q=JLab%20Go%20Air%20Pop');
  });
});

describe('parseSearchResults', () => {
  it('collects headphones review candidates (deduped, titles stripped)', () => {
    const html = `
      <a href="/headphones/reviews/jlab-audio/go-air-pop-true-wireless"><b>JLab Audio</b> GO Air POP</a>
      <a href="https://www.rtings.com/headphones/reviews/sony/wf-1000xm4">Sony WF-1000XM4</a>
      <a href="/headphones/reviews/jlab-audio/go-air-pop-true-wireless">dup</a>
      <a href="/monitor/reviews/dell/u2720q">not headphones</a>
      <a href="/headphones/reviews">hub page (no model)</a>`;
    const out = parseSearchResults(html);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      url: 'https://www.rtings.com/headphones/reviews/jlab-audio/go-air-pop-true-wireless',
      title: 'JLab Audio GO Air POP',
    });
    expect(out[1].url).toBe('https://www.rtings.com/headphones/reviews/sony/wf-1000xm4');
  });
});

describe('parseSearchApiResults', () => {
  it('collects review candidates from RTINGS internal search API JSON', () => {
    const out = parseSearchApiResults({
      data: {
        search_results: {
          results: [
            {
              title: 'Bose QuietComfort Ultra Earbuds Truly Wireless Headphones Review',
              url: '/headphones/reviews/bose/quietcomfort-ultra-earbuds-truly-wireless',
              page_type: 'review',
            },
            {
              title: 'The 7 Best AirPods Alternatives',
              url: '/headphones/reviews/best/airpods-alternatives',
              page_type: 'recommendation',
            },
            {
              title: 'Dell U2720Q Monitor Review',
              url: '/monitor/reviews/dell/u2720q',
              page_type: 'review',
            },
          ],
        },
      },
    });
    expect(out).toEqual([
      {
        url: 'https://www.rtings.com/headphones/reviews/bose/quietcomfort-ultra-earbuds-truly-wireless',
        title: 'Bose QuietComfort Ultra Earbuds Truly Wireless Headphones Review',
      },
    ]);
  });
});

describe('parseReviewPage — real fixture', () => {
  const analysis = parseReviewPage(REVIEW_HTML);

  it('matches the product and exposes RTINGS provenance', () => {
    expect(analysis.productMatched).toBe(true);
    expect(analysis.sourceId).toBe('rtings');
    expect(analysis.sourceLabel).toBe('RTINGS');
    expect(analysis.sourceUrl).toBe(
      'https://www.rtings.com/headphones/reviews/jlab-audio/go-air-pop-true-wireless',
    );
  });

  it('produces one expert review with the editorial body', () => {
    expect(analysis.reviews).toHaveLength(1);
    const r = analysis.reviews[0];
    expect(r.kind).toBe('expert');
    expect(r.text).toContain('JLab Audio GO Air POP');
    expect(r.text.length).toBeGreaterThan(40);
  });

  it('normalizes the 7.6/10 expert rating to the 0..5 scale (3.8)', () => {
    expect(analysis.reviews[0].rating).toBe(3.8);
  });

  it('carries the publication date (YYYY-MM-DD)', () => {
    expect(analysis.reviews[0].date).toBe('2024-09-25');
  });

  it('returns productMatched:false on HTML without a Product JSON-LD block', () => {
    const out = parseReviewPage('<html><body>no structured data</body></html>');
    expect(out.productMatched).toBe(false);
    expect(out.reviews).toHaveLength(0);
  });
});

describe('fetchAnalysis — orchestration (mocked fetch)', () => {
  function mockFetch(routes: Record<string, string | null>): typeof fetch {
    return (async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = Object.keys(routes).find((k) => url.includes(k));
      const body = key ? routes[key] : null;
      if (body == null) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
  }

  function searchApiBody(results: Array<{ title: string; url: string; page_type?: string }>): string {
    return JSON.stringify({
      data: {
        search_results: {
          results: results.map((r) => ({ page_type: 'review', ...r })),
        },
      },
    });
  }

  const SEARCH_HTML =
    '<a href="/headphones/reviews/jlab-audio/go-air-pop-true-wireless">JLab Audio GO Air POP True Wireless</a>';

  it('rejects non-headphones up front without any fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchAnalysis({ title: 'Licuadora Oster' }, fetchImpl);
    expect(out.productMatched).toBe(false);
    expect(called).toBe(false);
  });

  it('matches and parses the review for a covered product', async () => {
    const fetchImpl = mockFetch({
      '/search': SEARCH_HTML,
      'go-air-pop-true-wireless': REVIEW_HTML,
    });
    const out = await fetchAnalysis(JLAB, fetchImpl);
    expect(out.productMatched).toBe(true);
    expect(out.reviews[0].rating).toBe(3.8);
    expect(out.matchConfidence).toBeGreaterThanOrEqual(RTINGS_MATCH_THRESHOLD);
  });

  it('uses RTINGS internal search API results when the Vue search HTML has no anchors', async () => {
    const fetchImpl = mockFetch({
      '/api/v2/safe/app/search__search_results': searchApiBody([
        {
          title: 'Bose QuietComfort Ultra Earbuds (2nd Gen) Headphones Review',
          url: '/headphones/reviews/bose/quietcomfort-ultra-earbuds-2nd-gen',
        },
        {
          title: 'Bose QuietComfort Ultra Earbuds Truly Wireless Headphones Review',
          url: '/headphones/reviews/bose/quietcomfort-ultra-earbuds-truly-wireless',
        },
      ]),
      'quietcomfort-ultra-earbuds-truly-wireless': REVIEW_HTML,
    });
    const out = await fetchAnalysis({ title: 'Auriculares Bose QuietComfort Ultra Earbuds Negro' }, fetchImpl);
    expect(out.productMatched).toBe(true);
    expect(out.sourceUrl).toBe(
      'https://www.rtings.com/headphones/reviews/bose/quietcomfort-ultra-earbuds-truly-wireless',
    );
  });

  it('falls back (no match) when the best candidate is below the threshold', async () => {
    const fetchImpl = mockFetch({
      '/search': '<a href="/headphones/reviews/sony/wf-1000xm4">Sony WF-1000XM4 Truly Wireless</a>',
    });
    const out = await fetchAnalysis(JLAB, fetchImpl);
    expect(out.productMatched).toBe(false);
    expect(out.matchConfidence).toBeLessThan(RTINGS_MATCH_THRESHOLD);
  });

  it('falls back when search returns no candidates', async () => {
    const out = await fetchAnalysis(JLAB, mockFetch({ '/search': '<html>nothing</html>' }));
    expect(out.productMatched).toBe(false);
  });
});
