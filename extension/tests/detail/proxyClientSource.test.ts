// Proxy client — external-source behavior: the 'no_source_data' 200 marker maps
// to the 'no-source-data' SummaryError, and sourceMeta on a valid summary is
// passed through. Mocked fetch only.

import { describe, it, expect, vi } from 'vitest';
import { fetchSummary } from '../../src/detail/proxyClient';
import type { ProxyRequest } from '../../src/detail/types';

const EXTERNAL_REQUEST: ProxyRequest = {
  source: 'rtings',
  productId: 'MLM123456789',
  productTitle: 'Audífonos JLab Go Air Pop',
  productQuery: { title: 'Audífonos JLab Go Air Pop' },
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(impl: () => Response): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('proxy client — external sources', () => {
  it('maps a 200 no_source_data marker to the no-source-data error', async () => {
    const f = mockFetch(() =>
      jsonRes({ error: 'no_source_data', sourceMeta: { sourceId: 'rtings', label: 'RTINGS', matched: false } }),
    );
    const result = await fetchSummary(EXTERNAL_REQUEST, f);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('no-source-data');
  });

  it('passes sourceMeta through on a valid external summary', async () => {
    const meta = { sourceId: 'rtings', label: 'RTINGS', url: 'https://www.rtings.com/x', matched: true };
    const f = mockFetch(() =>
      jsonRes({ strongPoints: ['a'], weakPoints: ['b'], verdict: 'ok', sourceMeta: meta }),
    );
    const result = await fetchSummary(EXTERNAL_REQUEST, f);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.sourceMeta).toEqual(meta);
  });

  it('sends source + productQuery in the request body', async () => {
    const f = mockFetch(() => jsonRes({ strongPoints: [], weakPoints: [], verdict: 'ok' }));
    await fetchSummary(EXTERNAL_REQUEST, f);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.source).toBe('rtings');
    expect(body.productQuery).toEqual({ title: 'Audífonos JLab Go Air Pop' });
  });
});
