// Live source-switching integration tests. A synthetic PDP (reviews in a
// #__NEXT_DATA__ blob, as in detail.test.ts) feeds ml-internal; the proxy is
// mocked to answer differently by `source` so we can drive the toggle and assert
// the card re-renders for the selected source, including the no-data fallback.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runDetailSummary } from '../../src/detail';
import type { ProxyResponse, ReviewText } from '../../src/detail/types';

const PRODUCT_URL = 'https://articulo.mercadolibre.com.mx/MLM222222-audifonos';

const REVIEWS: ReviewText[] = [{ rating: 5, text: 'Excelentes audífonos' }];
const ML_SUMMARY: ProxyResponse = { strongPoints: ['ML bueno'], weakPoints: [], verdict: 'ML verdict.' };
const RTINGS_SUMMARY: ProxyResponse = {
  strongPoints: ['Sonido medido'],
  weakPoints: ['Sin app'],
  verdict: 'RTINGS verdict.',
  sourceMeta: { sourceId: 'rtings', label: 'RTINGS', url: 'https://www.rtings.com/x', matched: true },
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mountPdp(title = 'Audífonos JLab Go Air Pop'): void {
  const next = JSON.stringify({ props: { pageProps: { reviews: REVIEWS } } });
  document.body.innerHTML =
    `<h1>${title}</h1><script id="__NEXT_DATA__" type="application/json">${next}</script>`;
}

/** A proxy mock that answers by the request's `source`. */
function bySource(rtingsBody: unknown): typeof fetch {
  return vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.source === 'rtings') return Promise.resolve(jsonRes(rtingsBody));
    return Promise.resolve(jsonRes(ML_SUMMARY));
  }) as unknown as typeof fetch;
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
});

describe('runDetailSummary — live source switching', () => {
  it('renders ml-internal, then switches to RTINGS and re-renders with attribution', async () => {
    mountPdp();
    const fetchImpl = bySource(RTINGS_SUMMARY);
    const controller = runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });

    await vi.waitFor(() => expect(cardState()).toBe('result'));
    expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe('ML verdict.');

    controller.setSource('rtings');
    await vi.waitFor(() =>
      expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe('RTINGS verdict.'),
    );
    expect(controller.currentSource).toBe('rtings');
    // Attribution footer links back to the original analysis.
    const link = card().querySelector('.ml-summary-card__attribution a') as HTMLAnchorElement | null;
    expect(link?.href).toContain('rtings.com');
  });

  it('renders the no-source-data fallback when RTINGS has no analysis', async () => {
    mountPdp();
    const fetchImpl = bySource({
      error: 'no_source_data',
      sourceMeta: { sourceId: 'rtings', label: 'RTINGS', matched: false },
    });
    const controller = runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    await vi.waitFor(() => expect(cardState()).toBe('result'));

    controller.setSource('rtings');
    await vi.waitFor(() => expect(cardState()).toBe('no-source-data'));
    const btn = card().querySelector('.ml-summary-card__switch') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    // The fallback button switches back to ML opinions.
    btn.click();
    await vi.waitFor(() => {
      expect(controller.currentSource).toBe('ml-internal');
      expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe('ML verdict.');
    });
  });

  it('caches per source: switching back to ML does not re-fetch', async () => {
    mountPdp();
    const fetchImpl = bySource(RTINGS_SUMMARY);
    const controller = runDetailSummary({ doc: document, url: PRODUCT_URL, fetchImpl });
    await vi.waitFor(() => expect(cardState()).toBe('result'));
    const callsAfterMl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    controller.setSource('rtings');
    await vi.waitFor(() => expect(controller.currentSource).toBe('rtings'));
    await vi.waitFor(() =>
      expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe('RTINGS verdict.'),
    );

    controller.setSource('ml-internal');
    // ml-internal summary was cached on the first render -> a cache hit, no fetch.
    await vi.waitFor(() =>
      expect(card().querySelector('.ml-summary-card__verdict p')?.textContent).toBe('ML verdict.'),
    );
    const totalCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    // Exactly one extra fetch (the RTINGS one); the ML re-render hit the cache.
    expect(totalCalls).toBe(callsAfterMl + 1);
  });
});
