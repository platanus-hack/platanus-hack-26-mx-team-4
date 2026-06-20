// Proxy client tests — mock fetch and assert: the request targets the proxy
// endpoint with POST + JSON body containing ONLY public review data (NO API
// key anywhere), and that status codes / parse failures map to the right
// SummaryError kind. No live network is used.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSummary, PROXY_BASE } from '../../src/detail/proxyClient';
import type { ProxyRequest, ProxyResponse } from '../../src/detail/types';

const REQUEST: ProxyRequest = {
  productId: 'MLM123456789',
  productTitle: 'Auriculares Bluetooth',
  reviews: [{ rating: 5, text: 'Excelente' }],
};

const VALID: ProxyResponse = {
  strongPoints: ['Buena batería'],
  weakPoints: ['Cable corto'],
  verdict: 'Sólido.',
};

function jsonRes(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('proxy client — request shape (no secrets in the bundle)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the proxy /api/summarize endpoint', async () => {
    const f = mockFetch(() => jsonRes(VALID));
    await fetchSummary(REQUEST, f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PROXY_BASE}/api/summarize`);
    expect(init.method).toBe('POST');
  });

  it('sends Content-Type: application/json', async () => {
    const f = mockFetch(() => jsonRes(VALID));
    await fetchSummary(REQUEST, f);
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('the request body contains ONLY public review data (no API key field)', async () => {
    const f = mockFetch(() => jsonRes(VALID));
    await fetchSummary(REQUEST, f);
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      productId: REQUEST.productId,
      productTitle: REQUEST.productTitle,
      reviews: REQUEST.reviews,
    });
    // No secret material is ever sent from the extension.
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('GEMINI_API_KEY');
    expect(body).not.toHaveProperty('key');
    expect(JSON.stringify(body)).not.toMatch(/gemini|api[_-]?key/i);
  });
});

describe('proxy client — response handling', () => {
  it('returns the parsed summary on a valid 200 response', async () => {
    const r = await fetchSummary(REQUEST, mockFetch(() => jsonRes(VALID)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(VALID);
  });

  it('accepts a valid JSON string body', async () => {
    const r = await fetchSummary(
      REQUEST,
      mockFetch(() => jsonRes(JSON.stringify(VALID))),
    );
    expect(r.ok).toBe(true);
  });

  it('maps a 429 to rate-limited', async () => {
    const r = await fetchSummary(REQUEST, mockFetch(() => jsonRes({ error: 'slow down' }, { status: 429 })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('rate-limited');
  });

  it('maps a 500 to proxy-error', async () => {
    const r = await fetchSummary(REQUEST, mockFetch(() => jsonRes({ error: 'boom' }, { status: 500 })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('proxy-error');
  });

  it('maps a 502 to proxy-error', async () => {
    const r = await fetchSummary(REQUEST, mockFetch(() => jsonRes({ error: 'bad gateway' }, { status: 502 })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('proxy-error');
  });

  it('maps a 2xx with malformed body to malformed', async () => {
    const r = await fetchSummary(REQUEST, mockFetch(() => jsonRes({ strongPoints: [] })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('maps a fetch rejection to network', async () => {
    const f = mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const r = await fetchSummary(REQUEST, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('network');
  });

  it('maps a non-JSON 200 body to malformed', async () => {
    const f = mockFetch(() => new Response('not json', { status: 200 }));
    const r = await fetchSummary(REQUEST, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });
});
