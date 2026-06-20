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
  readBody,
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
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toEqual(VALID_SUMMARY);
  });
  it('returns null on a non-ok Gemini response', async () => {
    const f = mockFetch(() => jsonRes({ error: 'rate limited' }, { status: 429 }));
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toBeNull();
  });
  it('returns null when fetch rejects', async () => {
    const f = mockFetch(() => {
      throw new TypeError('network');
    });
    expect(await summarizeWithGemini(REQUEST as never, API_KEY, f)).toBeNull();
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
});

describe('applyCors + readBody', () => {
  it('applyCors sets the three CORS headers', () => {
    const res = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; } };
    applyCors(res as unknown as ServerResponse);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(res.headers['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('readBody concatenates the request stream chunks', async () => {
    const req = Readable.from([Buffer.from('hello'), Buffer.from(' world')]) as unknown as {
      on: EventEmitter['on'];
    };
    expect(await readBody(req as never)).toBe('hello world');
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

  function fakeReq(method: string, body: unknown): { req: unknown; emit: () => void } {
    const ee = new EventEmitter();
    (ee as unknown as { method: string }).method = method;
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
    expect(fr.headers()['Access-Control-Allow-Origin']).toBe('*');
    const body = JSON.parse(fr.body());
    expect(body).toEqual(VALID_SUMMARY);
    expect(fr.body()).not.toContain(API_KEY);
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
