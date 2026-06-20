// Detail-pipeline integration tests (Pilar 2). The real PDP fixture is BLOCKED
// (Batch 0), so these use a SYNTHETIC PDP whose reviews live in a Next.js
// `#__NEXT_DATA__` blob (the adapter's generic hydration path) to exercise the
// full wiring: extract -> cache -> proxy -> render, the lazy-reviews observer,
// cache-hit-no-fetch, and error -> retry. Everything runs in the global vitest
// jsdom document (single realm) so the MutationObserver works.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runDetailSummary, toProxyRequest } from '../../src/detail';
import { writeCache, cacheKey, reviewsFingerprint } from '../../src/detail/cache';
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
// Cache identity is keyed by productId + a fingerprint of the extracted reviews
// (Issue 6). The pipeline computes this same fingerprint from REVIEWS, so the
// pre-populated cache entry below hits.
const FP = reviewsFingerprint(REVIEWS);

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
    // The summary was cached after the successful fetch (under the review-set
    // fingerprint, so a changed review set would miss).
    expect(localStorage.getItem(cacheKey(PRODUCT_ID, FP))).not.toBeNull();
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
    writeCache(PRODUCT_ID, FP, SUMMARY);
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

  it('a second retry click while a fetch is in-flight does NOT start a second fetch (Issue 4)', async () => {
    mountPdp(REVIEWS);
    // First call: error. Second call: hangs until we resolve it so inFlight
    // stays true across the double-click.
    let calls = 0;
    let resolveSecond!: () => void;
    const hangingSecond = new Promise<Response>((resolve) => {
      resolveSecond = () => resolve(jsonRes(SUMMARY));
    });
    const fetchImpl = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonRes({ error: 'boom' }, 500));
      return hangingSecond;
    }) as unknown as typeof fetch;

    runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    await vi.waitFor(() => expect(cardState()).toBe('error'));

    const retryBtn = card().querySelector<HTMLButtonElement>('.ml-summary-card__retry')!;
    // First click starts fetch #2 (inFlight = true, hanging). Second click MUST
    // early-return because inFlight is still true — no third fetch.
    retryBtn.click();
    retryBtn.click();
    // Let pending microtasks settle so a hypothetical third call would surface.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Cleanup: let the hanging fetch resolve so the pipeline settles.
    resolveSecond();
    await vi.waitFor(() => expect(cardState()).toBe('result'));
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
    // (cache is keyed per product + fingerprint; this test must observe a real
    // fetch). The lazy PDP hydrates with the SAME REVIEWS, so the fingerprint
    // matches FP.
    const lazyUrl = 'https://articulo.mercadolibre.com.mx/MLM222222-titulo-lazy';
    const lazyId = 'MLM222222';
    try {
      localStorage.removeItem(cacheKey(lazyId, FP));
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
      localStorage.removeItem(cacheKey(lazyId, FP));
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

  it('destroy() disconnects the observer: mutations after destroy do NOT re-extract (Issue 5)', async () => {
    // Start with no reviews -> empty state + observer running.
    mountPdp(null);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    expect(cardState()).toBe('empty');
    controller.destroy();
    expect(document.body.querySelector('.ml-summary-card')).toBeNull();

    // Mutate the DOM after destroy — the observer is disconnected, so no fetch.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);
    // Wait past the 250ms debounce so a re-extract would have fired if the
    // observer were still attached.
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops observing after the empty-state attempt cap (does not observe forever) (Issue 5)', async () => {
    // Use a small injectable cap so the test does not need to fire 20 mutations.
    mountPdp(null);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({
      doc: document,
      url: PRODUCT_URL,
      fetchImpl,
      maxEmptyAttempts: 3,
      emptyObserveTimeoutMs: 60_000, // disable the timeout branch for this test
    });
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    // Trigger 2 external mutations. Each fires the observer, debounces 250ms,
    // then re-extracts (still empty). emptyAttempts: 1 (initial) + 2 = 3 -> cap
    // hit -> stopObserver.
    for (let i = 0; i < 2; i++) {
      const div = document.createElement('div');
      div.className = 'external-noise-' + i;
      document.body.appendChild(div);
      // Wait past the 250ms debounce so attempt() runs before the next mutation.
      await new Promise((r) => setTimeout(r, 320));
    }
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    // Add reviews now: the observer is disconnected, so this does NOT trigger a
    // re-extract. The empty state stays.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);
    await new Promise((r) => setTimeout(r, 400));
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    controller.destroy();
  });

  it('stops observing after the empty-state timeout window (does not observe forever) (Issue 5)', async () => {
    // Use a tiny timeout so the test runs fast; the attempt cap is high so only
    // the timeout branch triggers.
    mountPdp(null);
    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({
      doc: document,
      url: PRODUCT_URL,
      fetchImpl,
      maxEmptyAttempts: 1000, // disable the attempt branch for this test
      emptyObserveTimeoutMs: 200,
    });
    expect(cardState()).toBe('empty');

    // Wait past the empty-state timeout window. The scheduled timeout fires
    // stopObserver even though no mutations occurred.
    await new Promise((r) => setTimeout(r, 350));
    expect(cardState()).toBe('empty');

    // Add reviews: observer is disconnected, no re-extract, no fetch.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);
    await new Promise((r) => setTimeout(r, 400));
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    controller.destroy();
  });

  it('keeps observing past the empty-state cap when hasMoreReviewsHint is true (Round 2)', async () => {
    // PDP with NO reviews but WITH a "Mostrar todas las opiniones" control ->
    // the disconnect cap is NOT applied: reviews can still arrive via
    // user-driven expansion after the cap window, so we keep observing.
    mountPdp(null);
    const moreBtn = document.createElement('button');
    moreBtn.className = 'show-more-click';
    moreBtn.textContent = 'Mostrar todas las opiniones';
    document.body.appendChild(moreBtn);

    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({
      doc: document,
      url: PRODUCT_URL,
      fetchImpl,
      maxEmptyAttempts: 3, // small cap; we will blow past it
      emptyObserveTimeoutMs: 60_000, // disable the timeout branch for this test
    });
    expect(cardState()).toBe('empty');
    // The empty hint is shown because hasMoreReviewsHint is true.
    expect(card().querySelector('.ml-summary-card__hint')).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();

    // Trigger external mutations PAST the cap of 3. The observer must NOT
    // disconnect because hasMoreReviewsHint is true (reviews may still come).
    for (let i = 0; i < 5; i++) {
      const div = document.createElement('div');
      div.className = 'external-noise-' + i;
      document.body.appendChild(div);
      // Wait past the 250ms debounce so attempt() runs before the next mutation.
      await new Promise((r) => setTimeout(r, 320));
    }
    expect(cardState()).toBe('empty');

    // Now hydrate reviews: the observer is still attached, so it re-extracts
    // and renders the result — proving observation persisted past the cap.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);
    await vi.waitFor(() => expect(cardState()).toBe('result'), { timeout: 2000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  it('stops observing at the empty-state cap when hasMoreReviewsHint is false (Round 2)', async () => {
    // Truly empty PDP (no more-reviews control) -> the cap IS applied. This
    // mirrors the existing Issue-5 cap tests but asserts the hint is absent.
    mountPdp(null);
    expect(document.body.querySelector('.show-more-click')).toBeNull();

    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({
      doc: document,
      url: PRODUCT_URL,
      fetchImpl,
      maxEmptyAttempts: 3,
      emptyObserveTimeoutMs: 60_000,
    });
    expect(cardState()).toBe('empty');
    // No hint shown (hasMoreReviewsHint false).
    expect(card().querySelector('.ml-summary-card__hint')).toBeNull();

    // Trigger 2 external mutations -> emptyAttempts: 1 (initial) + 2 = 3 -> cap.
    for (let i = 0; i < 2; i++) {
      const div = document.createElement('div');
      div.className = 'external-noise-' + i;
      document.body.appendChild(div);
      await new Promise((r) => setTimeout(r, 320));
    }
    expect(cardState()).toBe('empty');

    // Hydrate reviews AFTER the cap: observer disconnected -> no re-extract.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);
    await new Promise((r) => setTimeout(r, 400));
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    controller.destroy();
  });

  it('stops observing at the ABSOLUTE cap even when hasMoreReviewsHint is true (Round 3)', async () => {
    // Even with a more-reviews hint, the observer must NOT run forever: the
    // absolute ceiling (maxTotalEmptyAttempts / absoluteObserveTimeoutMs) bounds
    // it regardless of the hint, so a PDP that shows the control but never
    // hydrates reviews eventually disconnects.
    mountPdp(null);
    const moreBtn = document.createElement('button');
    moreBtn.className = 'show-more-click';
    moreBtn.textContent = 'Mostrar todas las opiniones';
    document.body.appendChild(moreBtn);

    const fetchImpl = vi.fn(() => Promise.resolve(jsonRes(SUMMARY))) as unknown as typeof fetch;
    const controller = runDetailSummary({
      doc: document,
      url: PRODUCT_URL,
      fetchImpl,
      maxEmptyAttempts: 1000, // short cap disabled (irrelevant in the hint path)
      emptyObserveTimeoutMs: 60_000,
      maxTotalEmptyAttempts: 3, // ABSOLUTE cap: initial + 2 = 3 -> disconnect
      absoluteObserveTimeoutMs: 60_000, // disable the absolute timeout branch
    });
    expect(cardState()).toBe('empty');
    expect(card().querySelector('.ml-summary-card__hint')).not.toBeNull();

    // 2 external mutations -> totalEmptyAttempts: 1 (initial) + 2 = 3 -> absolute cap.
    for (let i = 0; i < 2; i++) {
      const div = document.createElement('div');
      div.className = 'abs-noise-' + i;
      document.body.appendChild(div);
      await new Promise((r) => setTimeout(r, 320));
    }
    expect(cardState()).toBe('empty');

    // Hydrate reviews AFTER the absolute cap: observer is gone -> no re-extract.
    const newScript = document.createElement('script');
    newScript.id = '__NEXT_DATA__';
    newScript.type = 'application/json';
    newScript.textContent = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
    document.body.querySelector('#__NEXT_DATA__')!.replaceWith(newScript);
    await new Promise((r) => setTimeout(r, 400));
    expect(cardState()).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();

    controller.destroy();
  });
});
