// Proxy unit tests — mocked Gemini REST fetch + fake Node req/res. No live
// network, no real API key. Verifies: request building (responseSchema + key in
// header, never echoed back), response parsing, error mapping (400/500/502),
// CORS preflight (204), and that the API key never appears in any response.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import handler, {
  buildGeminiRequest,
  buildPrompt,
  isProxyRequest,
  isProxyResponse,
  parseGeminiResponse,
  summarizeWithGemini,
  handleRequest,
  applyCors,
  isMercadoLibreOrigin,
  readBody,
  truncateReviews,
} from '../api/summarize';

const API_KEY = 'test-gemini-key-DO-NOT-USE';
const REQUEST = {
  productId: 'MLM123456789',
  productTitle: 'Auriculares Bluetooth',
  reviews: [
    { rating: 5, text: 'Excelente batería' },
    { rating: 3, text: 'Cable corto', date: '2025-01-02' },
  ],
};

const VALID_SUMMARY = {
  strongPoints: ['Buena batería', 'Sonido claro'],
  weakPoints: ['Cable corto'],
  verdict: 'Relación calidad-precio sólida.',
};

/** Build a Gemini REST response body wrapping `structured` as the JSON text. */
function geminiBody(structured: unknown, opts: { blocked?: boolean } = {}): unknown {
  if (opts.blocked) return { candidates: [] };
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(structured) }] },
      },
    ],
  };
}

function jsonRes(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('buildGeminiRequest + buildPrompt', () => {
  it('targets the gemini-2.5-flash generateContent endpoint', () => {
    const r = buildGeminiRequest(REQUEST, API_KEY);
    expect(r.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  it('puts the API key in the x-goog-api-key header (not the URL/body)', () => {
    const r = buildGeminiRequest(REQUEST, API_KEY);
    expect(r.headers['x-goog-api-key']).toBe(API_KEY);
    expect(r.url).not.toContain(API_KEY);
    expect(r.body).not.toContain(API_KEY);
  });

  it('sets responseMimeType application/json + responseSchema with the three fields', () => {
    const r = buildGeminiRequest(REQUEST, API_KEY);
    const body = JSON.parse(r.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    const schema = body.generationConfig.responseSchema;
    expect(schema.type).toBe('OBJECT');
    expect(schema.required).toEqual(['strongPoints', 'weakPoints', 'verdict']);
    expect(schema.properties.strongPoints.type).toBe('ARRAY');
    expect(schema.properties.verdict.type).toBe('STRING');
  });

  it('the prompt includes the product title and every review text', () => {
    const prompt = buildPrompt(REQUEST);
    expect(prompt).toContain(REQUEST.productTitle);
    expect(prompt).toContain('Excelente batería');
    expect(prompt).toContain('Cable corto');
  });
});

describe('isProxyRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isProxyRequest(REQUEST)).toBe(true);
  });
  it('rejects missing productId', () => {
    expect(isProxyRequest({ productTitle: 'x', reviews: [] })).toBe(false);
  });
  it('rejects non-array reviews', () => {
    expect(isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: 'no' })).toBe(false);
  });
  it('rejects a review without text', () => {
    expect(
      isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5 }] }),
    ).toBe(false);
  });
  it('accepts null rating', () => {
    expect(
      isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: [{ rating: null, text: 'ok' }] }),
    ).toBe(true);
  });
  it('rejects an empty reviews array (would otherwise trigger an empty-prompt Gemini call)', () => {
    expect(isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: [] })).toBe(false);
  });
  it('rejects reviews whose text is only whitespace', () => {
    expect(
      isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5, text: '   ' }] }),
    ).toBe(false);
  });
  it('rejects more than MAX_REVIEWS defensively', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ rating: 5, text: `review ${i}` }));
    expect(isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: tooMany })).toBe(false);
  });
  it('ACCEPTS a review whose text exceeds MAX_REVIEW_CHARS (truncated later, not rejected)', () => {
    // The per-review text length cap is enforced by truncation post-validation,
    // not by isProxyRequest, so a single long review never fails the summary.
    const tooLong = 'x'.repeat(4001);
    expect(
      isProxyRequest({ productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5, text: tooLong }] }),
    ).toBe(true);
  });
});

describe('truncateReviews — over-long text is truncated, not rejected', () => {
  it('truncates a review whose text exceeds MAX_REVIEW_CHARS to exactly the cap', () => {
    const tooLong = 'x'.repeat(5000);
    const out = truncateReviews({
      productId: 'MLM1',
      productTitle: 'x',
      reviews: [{ rating: 5, text: tooLong }, { rating: 4, text: 'ok' }],
    });
    expect(out.reviews[0].text.length).toBe(4000);
    expect(out.reviews[0].text).toBe('x'.repeat(4000));
    // Other reviews are untouched.
    expect(out.reviews[1].text).toBe('ok');
  });
  it('does not mutate the original request', () => {
    const tooLong = 'x'.repeat(4001);
    const req = { productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5, text: tooLong }] };
    const out = truncateReviews(req);
    expect(req.reviews[0].text.length).toBe(4001);
    expect(out.reviews[0].text.length).toBe(4000);
  });
  it('leaves within-cap text unchanged', () => {
    const req = { productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5, text: 'corta' }] };
    expect(truncateReviews(req).reviews[0].text).toBe('corta');
  });
});

describe('isProxyResponse', () => {
  it('accepts a valid summary', () => expect(isProxyResponse(VALID_SUMMARY)).toBe(true));
  it('rejects an empty verdict', () =>
    expect(isProxyResponse({ strongPoints: [], weakPoints: [], verdict: '' })).toBe(false));
  it('rejects non-array sections', () =>
    expect(isProxyResponse({ strongPoints: 'x', weakPoints: [], verdict: 'v' })).toBe(false));
});

describe('parseGeminiResponse', () => {
  it('extracts the structured summary from candidates[0].content.parts[0].text', () => {
    expect(parseGeminiResponse(geminiBody(VALID_SUMMARY))).toEqual(VALID_SUMMARY);
  });
  it('returns null when candidates are empty (safety-blocked)', () => {
    expect(parseGeminiResponse(geminiBody({}, { blocked: true }))).toBeNull();
  });
  it('returns null when text is not JSON', () => {
    expect(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })).toBeNull();
  });
  it('returns null when the parsed JSON is not a valid summary', () => {
    expect(parseGeminiResponse(geminiBody({ strongPoints: [] }))).toBeNull();
  });
  it('returns null on a non-object body', () => {
    expect(parseGeminiResponse(null)).toBeNull();
    expect(parseGeminiResponse('x')).toBeNull();
  });
});

describe('summarizeWithGemini (mocked fetch)', () => {
  it('returns the summary on a valid Gemini response', async () => {
    const f = mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY)));
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toEqual({ ok: true, data: VALID_SUMMARY });
  });
  it('reports http_error + the upstream status on a non-ok Gemini response', async () => {
    const f = mockFetch(() => jsonRes({ error: 'forbidden' }, { status: 403 }));
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toEqual({
      ok: false,
      reason: 'http_error',
      upstreamStatus: 403,
    });
  });
  it('reports fetch_failed with a null status when fetch rejects', async () => {
    const f = mockFetch(() => {
      throw new TypeError('network');
    });
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toEqual({
      ok: false,
      reason: 'fetch_failed',
      upstreamStatus: null,
    });
  });
  it('reports malformed_candidates (with the 200 status) on a safety-blocked body', async () => {
    const f = mockFetch(() => jsonRes(geminiBody({}, { blocked: true })));
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toEqual({
      ok: false,
      reason: 'malformed_candidates',
      upstreamStatus: 200,
    });
  });
});

describe('handleRequest — HTTP status mapping', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('200 + summary on a valid request + valid Gemini response', async () => {
    const f = mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY)));
    const r = await handleRequest(REQUEST, API_KEY, f);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(VALID_SUMMARY);
  });

  it('400 on an invalid request', async () => {
    const r = await handleRequest({ foo: 'bar' }, API_KEY, mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY))));
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_request');
  });

  it('400 on an empty reviews array (no Gemini call wasted)', async () => {
    const f = mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY)));
    const r = await handleRequest(
      { productId: 'MLM1', productTitle: 'x', reviews: [] },
      API_KEY,
      f,
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_request');
    expect(f).not.toHaveBeenCalled();
  });

  it('truncates an over-long single review and still returns 200 (not 400)', async () => {
    // A single review over MAX_REVIEW_CHARS is truncated server-side and the
    // summary still proceeds — it must NOT fail the whole request.
    const f = mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY)));
    const tooLong = 'x'.repeat(5000);
    const r = await handleRequest(
      { productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5, text: tooLong }] },
      API_KEY,
      f,
    );
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    // The review text sent to Gemini was truncated to MAX_REVIEW_CHARS (4000).
    const sent = JSON.parse((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    const prompt = sent.contents[0].parts[0].text as string;
    expect(prompt).toContain('x'.repeat(4000));
    expect(prompt).not.toContain('x'.repeat(4001));
  });

  it('still 400 when the review COUNT is over the cap (count rejects, length truncates)', async () => {
    const f = mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY)));
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ rating: 5, text: `review ${i}` }));
    const r = await handleRequest({ productId: 'MLM1', productTitle: 'x', reviews: tooMany }, API_KEY, f);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_request');
    expect(f).not.toHaveBeenCalled();
  });

  it('400 on reviews with empty text (no Gemini call wasted)', async () => {
    const f = mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY)));
    const r = await handleRequest(
      { productId: 'MLM1', productTitle: 'x', reviews: [{ rating: 5, text: '   ' }] },
      API_KEY,
      f,
    );
    expect(r.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('500 when the API key is missing', async () => {
    const r = await handleRequest(REQUEST, undefined, mockFetch(() => jsonRes(geminiBody(VALID_SUMMARY))));
    expect(r.status).toBe(500);
    expect((r.body as { error: string }).error).toBe('missing_api_key');
  });

  it('502 when the model response is malformed', async () => {
    const f = mockFetch(() => jsonRes(geminiBody({}, { blocked: true })));
    const r = await handleRequest(REQUEST, API_KEY, f);
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toBe('malformed_model_response');
  });

  it('502 surfaces the upstream Gemini status + reason for diagnosis (e.g. bad key)', async () => {
    const f = mockFetch(() => jsonRes({ error: { message: 'API key not valid' } }, { status: 403 }));
    const r = await handleRequest(REQUEST, API_KEY, f);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      error: 'malformed_model_response',
      reason: 'http_error',
      gemini_status: 403,
    });
  });

  it('429 from Gemini is propagated AS 429 (rate_limited) so the client renders the limit state', async () => {
    const f = mockFetch(() => jsonRes({ error: { message: 'quota exceeded' } }, { status: 429 }));
    const r = await handleRequest(REQUEST, API_KEY, f);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'rate_limited', gemini_status: 429 });
  });

  it('502 body never leaks the API key', async () => {
    const f = mockFetch(() => jsonRes({ error: 'forbidden' }, { status: 403 }));
    const r = await handleRequest(REQUEST, API_KEY, f);
    expect(JSON.stringify(r.body)).not.toContain(API_KEY);
  });
});

describe('isMercadoLibreOrigin — CORS allow-list predicate', () => {
  it('accepts articulo.* ML origins across TLDs', () => {
    expect(isMercadoLibreOrigin('https://articulo.mercadolibre.com.mx')).toBe(true);
    expect(isMercadoLibreOrigin('https://articulo.mercadolibre.com.ar')).toBe(true);
    expect(isMercadoLibreOrigin('https://articulo.mercadolibre.com.br')).toBe(true);
  });
  it('accepts www.* and listado.* ML origins', () => {
    expect(isMercadoLibreOrigin('https://www.mercadolibre.com.mx')).toBe(true);
    expect(isMercadoLibreOrigin('https://listado.mercadolibre.com.ar')).toBe(true);
  });
  it('accepts a bare mercadolibre.<tld> origin', () => {
    expect(isMercadoLibreOrigin('https://mercadolibre.com.ar')).toBe(true);
    expect(isMercadoLibreOrigin('https://mercadolibre.cl')).toBe(true);
    expect(isMercadoLibreOrigin('https://mercadolibre.co')).toBe(true);
  });
  it('accepts the Brazilian mercadolivre.com.br (the "mercadoliVRE" spelling) + subdomains', () => {
    expect(isMercadoLibreOrigin('https://mercadolivre.com.br')).toBe(true);
    expect(isMercadoLibreOrigin('https://articulo.mercadolivre.com.br')).toBe(true);
    expect(isMercadoLibreOrigin('https://www.mercadolivre.com.br')).toBe(true);
  });
  it('rejects a fake-TLD look-alike (mercadolibre.xyz is NOT a real ML host)', () => {
    expect(isMercadoLibreOrigin('https://mercadolibre.xyz')).toBe(false);
    expect(isMercadoLibreOrigin('https://www.mercadolibre.xyz')).toBe(false);
    expect(isMercadoLibreOrigin('https://articulo.mercadolivre.com')).toBe(false);
  });
  it('rejects a prefix-attack host (evilmercadolibre.com is not a subdomain)', () => {
    expect(isMercadoLibreOrigin('https://evilmercadolibre.com')).toBe(false);
    expect(isMercadoLibreOrigin('https://evilmercadolibre.com.ar')).toBe(false);
  });
  it('rejects foreign origins', () => {
    expect(isMercadoLibreOrigin('https://evil.com')).toBe(false);
    expect(isMercadoLibreOrigin('https://example.net')).toBe(false);
  });
  it('rejects an invalid URL (never throws)', () => {
    expect(isMercadoLibreOrigin('not-a-url')).toBe(false);
    expect(isMercadoLibreOrigin('')).toBe(false);
  });
});

describe('applyCors + readBody', () => {
  function corsRes(): { res: ServerResponse; headers: () => Record<string, string> } {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
    };
    return { res: res as unknown as ServerResponse, headers: () => headers };
  }

  it('applyCors reflects an ML Origin (allow-list) + Vary: Origin', () => {
    const { res, headers } = corsRes();
    applyCors(res, 'https://articulo.mercadolibre.com.mx');
    expect(headers()['Access-Control-Allow-Origin']).toBe('https://articulo.mercadolibre.com.mx');
    expect(headers()['Vary']).toBe('Origin');
    expect(headers()['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(headers()['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('applyCors omits Access-Control-Allow-Origin for a foreign Origin (browser blocks it) but STILL sets Vary: Origin', () => {
    const { res, headers } = corsRes();
    applyCors(res, 'https://evil.com');
    expect(headers()).not.toHaveProperty('Access-Control-Allow-Origin');
    // Vary is unconditional so a shared/CDN cache cannot replay a wildcard
    // response to a foreign-origin browser request.
    expect(headers()['Vary']).toBe('Origin');
    // Methods/Headers are still set (they are not origin-reflective).
    expect(headers()['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(headers()['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('applyCors keeps the wildcard when there is no Origin (curl / server-to-server) and sets Vary: Origin', () => {
    const { res, headers } = corsRes();
    applyCors(res, undefined);
    expect(headers()['Access-Control-Allow-Origin']).toBe('*');
    // Vary is set unconditionally (all branches), including the wildcard case.
    expect(headers()['Vary']).toBe('Origin');
    expect(headers()['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(headers()['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('applyCors reflects the Brazilian mercadolivre.com.br origin', () => {
    const { res, headers } = corsRes();
    applyCors(res, 'https://articulo.mercadolivre.com.br');
    expect(headers()['Access-Control-Allow-Origin']).toBe('https://articulo.mercadolivre.com.br');
    expect(headers()['Vary']).toBe('Origin');
  });

  it('applyCors does NOT reflect a fake-TLD origin (mercadolibre.xyz)', () => {
    const { res, headers } = corsRes();
    applyCors(res, 'https://www.mercadolibre.xyz');
    expect(headers()).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(headers()['Vary']).toBe('Origin');
  });

  it('readBody concatenates the request stream chunks', async () => {
    const req = Readable.from([Buffer.from('hello'), Buffer.from(' world')]) as unknown as {
      on: EventEmitter['on'];
    };
    expect(await readBody(req as never)).toBe('hello world');
  });

  it('readBody rejects an oversize stream (>512KB) with body_too_large', async () => {
    const big = Buffer.alloc(600 * 1024, 'x');
    const req = Readable.from([big]) as unknown as { on: EventEmitter['on'] };
    await expect(readBody(req as never)).rejects.toThrow('body_too_large');
  });

  it('readBody accepts a stream within the 512KB cap (coherent with per-field caps)', async () => {
    // MAX_REVIEWS * MAX_REVIEW_CHARS ~ 400KB; a 450KB body is within the 512KB
    // cap and must be accepted (the previous 256KB cap rejected it).
    const big = Buffer.alloc(450 * 1024, 'x');
    const req = Readable.from([big]) as unknown as { on: EventEmitter['on'] };
    await expect(readBody(req as never)).resolves.toBeDefined();
  });

  it('readBody honors a custom maxBytes (rejects just above the cap)', async () => {
    const req = Readable.from([Buffer.from('hello world')]) as unknown as {
      on: EventEmitter['on'];
    };
    // 11-byte body, cap of 10 -> reject.
    await expect(readBody(req as never, 10)).rejects.toThrow('body_too_large');
  });
});

describe('handler — CORS preflight + POST end-to-end', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = API_KEY;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  function fakeReq(
    method: string,
    body: unknown,
    opts: { origin?: string } = {},
  ): { req: unknown; emit: () => void } {
    const ee = new EventEmitter();
    (ee as unknown as { method: string }).method = method;
    // Minimal headers object so the handler can read `origin` (case-insensitive).
    const headers: Record<string, string> = {};
    if (opts.origin != null) headers.origin = opts.origin;
    (ee as unknown as { headers: Record<string, string> }).headers = headers;
    const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return {
      req: ee,
      emit: () => {
        if (payload) ee.emit('data', Buffer.from(payload));
        ee.emit('end');
      },
    };
  }

  function fakeRes(): {
    res: ServerResponse;
    status: () => number;
    body: () => string;
    headers: () => Record<string, string>;
  } {
    const headers: Record<string, string> = {};
    let st = 0;
    let b = '';
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      writeHead: (status: number) => {
        st = status;
      },
      end: (data?: string) => {
        b = data ?? '';
      },
    };
    return {
      res: res as unknown as ServerResponse,
      status: () => st,
      body: () => b,
      headers: () => headers,
    };
  }

  it('OPTIONS returns 204 with CORS headers and no body', async () => {
    const { req } = fakeReq('OPTIONS', null);
    const fr = fakeRes();
    await handler(req as never, fr.res);
    expect(fr.status()).toBe(204);
    expect(fr.body()).toBe('');
    // No Origin header -> wildcard (tooling keeps working).
    expect(fr.headers()['Access-Control-Allow-Origin']).toBe('*');
    expect(fr.headers()['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
  });

  it('POST with a valid request returns 200 + CORS + the summary (no key in body)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', REQUEST);
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(200);
    // No Origin header -> wildcard.
    expect(fr.headers()['Access-Control-Allow-Origin']).toBe('*');
    const body = JSON.parse(fr.body());
    expect(body).toEqual(VALID_SUMMARY);
    expect(fr.body()).not.toContain(API_KEY);
  });

  it('POST reflects a MercadoLibre Origin in Access-Control-Allow-Origin', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', REQUEST, { origin: 'https://articulo.mercadolibre.com.mx' });
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(200);
    expect(fr.headers()['Access-Control-Allow-Origin']).toBe('https://articulo.mercadolibre.com.mx');
    expect(fr.headers()['Vary']).toBe('Origin');
  });

  it('POST with a foreign Origin returns 403 forbidden_origin BEFORE Gemini (no quota drain)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', REQUEST, { origin: 'https://evil.com' });
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(403);
    expect(JSON.parse(fr.body()).error).toBe('forbidden_origin');
    // Gemini was NOT called (request blocked before readBody/Gemini).
    expect(fetch).not.toHaveBeenCalled();
    // CORS: no Access-Control-Allow-Origin reflected (browser blocks too).
    expect(fr.headers()).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(fr.headers()['Vary']).toBe('Origin');
  });

  it('POST with a fake-TLD Origin (mercadolibre.xyz) returns 403 (not a real ML host)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', REQUEST, { origin: 'https://www.mercadolibre.xyz' });
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(403);
    expect(JSON.parse(fr.body()).error).toBe('forbidden_origin');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POST with the Brazilian mercadolivre.com.br Origin is reflected (allowed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', REQUEST, { origin: 'https://articulo.mercadolivre.com.br' });
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(200);
    expect(fr.headers()['Access-Control-Allow-Origin']).toBe('https://articulo.mercadolivre.com.br');
    expect(fr.headers()['Vary']).toBe('Origin');
  });

  it('POST with no Origin is allowed with the wildcard (curl / server-to-server)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', REQUEST);
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(200);
    expect(fr.headers()['Access-Control-Allow-Origin']).toBe('*');
    expect(fr.headers()['Vary']).toBe('Origin');
  });

  it('POST with an oversize body returns 413 (no Gemini call)', async () => {
    const f = vi.fn(() => Promise.resolve(jsonRes(geminiBody(VALID_SUMMARY))));
    vi.spyOn(globalThis, 'fetch').mockImplementation(f as unknown as typeof fetch);
    const ee = new EventEmitter();
    (ee as unknown as { method: string }).method = 'POST';
    (ee as unknown as { headers: Record<string, string> }).headers = {};
    const fr = fakeRes();
    const p = handler(ee as never, fr.res);
    // Emit one >512KB chunk.
    ee.emit('data', Buffer.alloc(600 * 1024, 'x'));
    ee.emit('end');
    await p;
    expect(fr.status()).toBe(413);
    expect(JSON.parse(fr.body()).error).toBe('body_too_large');
    expect(f).not.toHaveBeenCalled();
  });

  it('POST with an empty reviews array returns 400 (no Gemini call)', async () => {
    const f = vi.fn(() => Promise.resolve(jsonRes(geminiBody(VALID_SUMMARY))));
    vi.spyOn(globalThis, 'fetch').mockImplementation(f as unknown as typeof fetch);
    const { req, emit } = fakeReq('POST', { productId: 'MLM1', productTitle: 'x', reviews: [] });
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(400);
    expect(JSON.parse(fr.body()).error).toBe('invalid_request');
    expect(f).not.toHaveBeenCalled();
  });

  it('POST with malformed model output returns 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody({}, { blocked: true })));
    const { req, emit } = fakeReq('POST', REQUEST);
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(502);
    expect(JSON.parse(fr.body()).error).toBe('malformed_model_response');
  });

  it('POST with invalid JSON body returns 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(geminiBody(VALID_SUMMARY)));
    const { req, emit } = fakeReq('POST', '{not json');
    const fr = fakeRes();
    const p = handler(req as never, fr.res);
    emit();
    await p;
    expect(fr.status()).toBe(400);
  });

  it('GET returns 405 (only POST/OPTIONS allowed)', async () => {
    const { req } = fakeReq('GET', null);
    const fr = fakeRes();
    await handler(req as never, fr.res);
    expect(fr.status()).toBe(405);
  });
});
