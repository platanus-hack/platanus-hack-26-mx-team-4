// Detail-pipeline integration tests (Pilar 2). The real PDP fixture is BLOCKED
// (Batch 0), so these use a SYNTHETIC PDP whose reviews live in a Next.js
// `#__NEXT_DATA__` blob (the adapter's generic hydration path) to exercise the
// full wiring: extract -> cache -> proxy -> render, the lazy-reviews observer,
// cache-hit-no-fetch, and error -> retry. Everything runs in the global vitest
// jsdom document (single realm) so the MutationObserver works.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runDetailSummary, toProxyRequest } from '../../src/detail';
import { writeCache, cacheKey } from '../../src/detail/cache';
import type { ProxyResponse, ReviewText } from '../../src/detail/types';

const PRODUCT_URL = 'https://articulo.mercadolibre.com.mx/MLM111111-titulo-falso';
const PRODUCT_ID = 'MLM111111';

const SUMMARY: ProxyResponse = {
  strongPoints: ['Buena batería', 'Sonido claro'],
  weakPoints: ['Cable corto'],
  verdict: 'Relación calidad-precio sólida.',
};

const REVIEWS: ReviewText[] = [
  { rating: 5, text: 'Excelente batería' },
  { rating: 3, text: 'Cable corto', date: '2025-01-02' },
];

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Inject a synthetic PDP into the global document (single realm). */
function mountPdp(reviews: ReviewText[] | null, opts?: { title?: string; locale?: string }): void {
  const next = reviews ? JSON.stringify({ props: { pageProps: { reviews, locale: opts?.locale } } }) : '{}';
  document.body.innerHTML =
    `<h1>${opts?.title ?? 'Producto falso'}</h1>` +
    `<script id="__NEXT_DATA__" type="application/json">${next}</script>`;
}

function card(): HTMLElement {
  return document.body.querySelector('.ml-summary-card')!;
}
function cardState(): string {
  return card().getAttribute('data-ml-summary')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe('toProxyRequest', () => {
  it('drops the UI-only hint flag and includes locale when present', () => {
    const req = toProxyRequest({
      productId: 'MLM1',
      productTitle: 'X',
      locale: 'es-MX',
      reviews: REVIEWS,
      hasMoreReviewsHint: true,
    });
    expect(req).toEqual({ productId: 'MLM1', productTitle: 'X', locale: 'es-MX', reviews: REVIEWS });
    expect(req).not.toHaveProperty('hasMoreReviewsHint');
  });

  it('omits locale when absent', () => {
    const req = toProxyRequest({ productId: 'MLM1', productTitle: 'X', reviews: [], hasMoreReviewsHint: false });
    expect(req).not.toHaveProperty('locale');
  });
});

describe('runDetailSummary — full flow (cache miss)', () => {
  it('renders skeleton, fetches, then renders the result', async () => {
    mountPdp(REVIEWS);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;

    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });

    expect(cardState()).toBe('loading');
    await vi.waitFor(() => expect(cardState()).toBe('result'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe(SUMMARY.verdict);
    // The summary was cached after the successful fetch.
    expect(localStorage.getItem(cacheKey(PRODUCT_ID))).not.toBeNull();
  });

  it('sends only public review data to the proxy (no API key)', async () => {
    mountPdp(REVIEWS);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    await vi.waitFor(() => expect(cardState()).toBe('result'));

    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('apiKey');
    expect(body.productId).toBe(PRODUCT_ID);
    expect(body.reviews).toEqual(REVIEWS);
  });
});

describe('runDetailSummary — cache hit (no proxy call)', () => {
  it('renders the cached summary without calling fetch', async () => {
    mountPdp(REVIEWS);
    writeCache(PRODUCT_ID, SUMMARY);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;

    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });

    // Cache hit renders synchronously in the initial attempt.
    expect(cardState()).toBe('result');
    expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe(SUMMARY.verdict);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runDetailSummary — empty + error states', () => {
  it('renders the empty state when there are no reviews', () => {
    mountPdp(null);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    expect(cardState()).toBe('empty');
    expect(card().querySelector('.ml-summary-card__empty')?.textContent).toBe('Aún no hay opiniones para resumir.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renders the error state on a proxy failure, then retry succeeds', async () => {
    mountPdp(REVIEWS);
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      return Promise.resolve(calls === 1 ? jsonRes({ error: 'boom' }, 500) : jsonRes(SUMMARY));
    }) as unknown as typeof fetch;

    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    await vi.waitFor(() => expect(cardState()).toBe('error'));
    expect(card().querySelector('.ml-summary-card__error')).not.toBeNull();

    // Click retry -> second call returns the valid summary.
    card().querySelector<HTMLButtonElement>('.ml-summary-card__retry')!.click();
    await vi.waitFor(() => expect(cardState()).toBe('result'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('renders a calm hint and no retry button on 429 (rate-limited)', async () => {
    mountPdp(REVIEWS);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes({}, 429))) as unknown as typeof fetch;
    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    await vi.waitFor(() => expect(cardState()).toBe('error'));
    expect(card().querySelector('.ml-summary-card__retry')).toBeNull();
    expect(card().querySelector('.ml-summary-card__hint')).not.toBeNull();
  });
});

describe('runDetailSummary — lazy reviews via MutationObserver', () => {
  // Real timers + vi.waitFor: the observer delivers via microtasks and the
  // 250ms debounce is real, so polling past it is more reliable than faking
  // both the timer and the observer microtask delivery together.
  it('starts empty, then re-runs when reviews hydrate and renders the result', async () => {
    // Unique product id so no cached summary from earlier tests can collide
    // (cache is keyed per product; this test must observe a real fetch).
    const lazyUrl = 'https://articulo.mercadolibre.com.mx/MLM222222-titulo-lazy';
    const lazyId = 'MLM222222';
    try {
      localStorage.removeItem(cacheKey(lazyId));
    } catch {
      // ignore
    }

    // Start with NO reviews -> empty state + observer running.
    mountPdp(null);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({ doc: document, url: lazyUrl, fetchImpl });
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    // Simulate hydration completing: replace the empty #__NEXT_DATA__ script
    // with one carrying reviews. This is a childList mutation on document.body
    // (a new node appears) — the real-world signal for lazily-loaded content,
    // which the observer watches (childList + subtree). Rewriting textContent
    // would emit characterData, which the observer intentionally does NOT watch.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);

    // The observer fires on the external mutation, debounces 250ms, re-extracts,
    // fetches, and renders the result.
    await vi.waitFor(() => expect(cardState()).toBe('result'), { timeout: 2000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.destroy();
    try {
      localStorage.removeItem(cacheKey(lazyId));
    } catch {
      // ignore
    }
  });

  it('destroy() stops the observer and removes the card', () => {
    mountPdp(null);
    const controller = runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl: vi.fn() as never });
    expect(card()).not.toBeNull();
    controller.destroy();
    expect(document.body.querySelector('.ml-summary-card')).toBeNull();
  });
});
