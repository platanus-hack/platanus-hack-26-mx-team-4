// Vercel serverless function — ML Review Summary proxy (Pilar 2).
//
// POST /api/summarize  ->  Gemini 2.5 Flash  ->  structured summary JSON.
//
// The extension NEVER calls Gemini directly. It POSTs ONLY public review text +
// product context here; THIS function holds the GEMINI_API_KEY (Vercel env var)
// and calls Gemini's REST API. The key is server-side only: it is never logged,
// never returned to the client, and never imported into the extension bundle.
//
// We use the Gemini REST API directly (fetch) instead of the @google/generative-
// ai SDK: zero dependency, fully mock-testable, and the REST endpoint supports
// `responseMimeType: application/json` + `responseSchema` for the structured
// output contract (the SDK is not required to satisfy the locked decision).
//
// Contracts below MIRROR extension/src/detail/types.ts. They are duplicated, not
// imported, because the proxy is an independently deployable boundary; both
// sides validate defensively.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Mirror of extension ReviewText/ProxyRequest/ProxyResponse (see header). */
type ReviewText = { rating: number | null; text: string; date?: string };
type ProxyRequest = { productId: string; productTitle: string; locale?: string; reviews: ReviewText[] };
type ProxyResponse = { strongPoints: string[]; weakPoints: string[]; verdict: string };

/** Gemini 2.5 Flash REST endpoint (v1beta generateContent). */
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Structured-output schema enforced by Gemini (responseSchema). */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    strongPoints: { type: 'ARRAY', items: { type: 'STRING' } },
    weakPoints: { type: 'ARRAY', items: { type: 'STRING' } },
    verdict: { type: 'STRING' },
  },
  required: ['strongPoints', 'weakPoints', 'verdict'],
} as const;

/** JSON HTTP response helper body. */
type HttpResult = { status: number; body: unknown };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing with a mocked fetch / fake streams).
// ---------------------------------------------------------------------------

/** Build the Gemini REST request URL + headers + JSON body for a ProxyRequest. */
export function buildGeminiRequest(request: ProxyRequest, apiKey: string): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const prompt = buildPrompt(request);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
  return {
    url: GEMINI_URL,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  };
}

/** Compose the Spanish summarization prompt from product context + reviews. */
export function buildPrompt(request: ProxyRequest): string {
  const reviewLines = request.reviews.map((r, i) => {
    const rating = r.rating != null ? ` (estrellas: ${r.rating})` : '';
    const date = r.date ? ` [${r.date}]` : '';
    return `${i + 1}. ${r.text}${rating}${date}`;
  });
  return [
    `Sos un asistente que resume opiniones de productos de MercadoLibre.`,
    `Producto: ${request.productTitle}.`,
    `Opiniones:`,
    reviewLines.join('\n'),
    ``,
    `Resumí las opiniones en JSON con tres campos:`,
    `- strongPoints: lista de strings con los puntos a favor.`,
    `- weakPoints: lista de strings con los puntos en contra / defectos.`,
    `- verdict: un veredicto breve y claro sobre el producto.`,
    `Respondé SOLO el JSON, sin texto adicional.`,
  ].join('\n');
}

/** Structural guard for an incoming ProxyRequest. */
export function isProxyRequest(value: unknown): value is ProxyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.productId !== 'string' || !r.productId) return false;
  if (typeof r.productTitle !== 'string') return false;
  if (!Array.isArray(r.reviews)) return false;
  return r.reviews.every((rv) => {
    if (!rv || typeof rv !== 'object') return false;
    const v = rv as Record<string, unknown>;
    return typeof v.text === 'string' && (v.rating === null || typeof v.rating === 'number');
  });
}

/** Structural guard for a ProxyResponse (three string arrays + non-empty verdict). */
export function isProxyResponse(value: unknown): value is ProxyResponse {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.strongPoints) &&
    r.strongPoints.every((s) => typeof s === 'string') &&
    Array.isArray(r.weakPoints) &&
    r.weakPoints.every((s) => typeof s === 'string') &&
    typeof r.verdict === 'string' &&
    r.verdict.trim().length > 0
  );
}

/**
 * Defensively extract a ProxyResponse from a Gemini REST response body. With
 * `responseMimeType: application/json`, the structured JSON is in
 * `candidates[0].content.parts[0].text` as a JSON string. Returns null on any
 * missing/malformed candidate (incl. safety-blocked empty candidates).
 */
export function parseGeminiResponse(json: unknown): ProxyResponse | null {
  if (typeof json !== 'object' || json === null) return null;
  const j = json as Record<string, unknown>;
  const candidates = j.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as Record<string, unknown> | undefined;
  const parts = (first?.content as Record<string, unknown> | undefined)?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = (parts[0] as Record<string, unknown> | undefined)?.text;
  if (typeof text !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isProxyResponse(parsed) ? parsed : null;
}

/**
 * Why a Gemini call did not yield a usable summary. Surfaced (with the upstream
 * HTTP status) in the 502 body so production failures are diagnosable WITHOUT
 * leaking the API key or Gemini's raw response body:
 *   fetch_failed         -> the request never reached Gemini (network/DNS)
 *   http_error           -> Gemini returned non-2xx (e.g. 403 bad key, 404 model,
 *                           429 quota) — `upstreamStatus` carries the real code
 *   invalid_json         -> Gemini's 2xx body was not JSON
 *   malformed_candidates -> JSON parsed but had no valid summary (incl. safety
 *                           block / empty candidates)
 */
export type GeminiFailureReason = 'fetch_failed' | 'http_error' | 'invalid_json' | 'malformed_candidates';

/** Discriminated outcome of a Gemini call: a summary, or a diagnosable failure. */
export type GeminiOutcome =
  | { ok: true; data: ProxyResponse }
  | { ok: false; reason: GeminiFailureReason; upstreamStatus: number | null };

/**
 * Call Gemini and return either a valid ProxyResponse or a typed failure that
 * carries the upstream HTTP status (the handler maps any failure -> 502 and
 * echoes the status/reason for diagnosis). Accepts a fetchImpl so tests mock the
 * network without hitting Gemini. The API key never appears in the outcome.
 */
export async function summarizeWithGemini(
  request: ProxyRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeminiOutcome> {
  const { url, headers, body } = buildGeminiRequest(request, apiKey);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body });
  } catch {
    return { ok: false, reason: 'fetch_failed', upstreamStatus: null };
  }
  if (!res.ok) return { ok: false, reason: 'http_error', upstreamStatus: res.status };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'invalid_json', upstreamStatus: res.status };
  }
  const parsed = parseGeminiResponse(json);
  if (!parsed) return { ok: false, reason: 'malformed_candidates', upstreamStatus: res.status };
  return { ok: true, data: parsed };
}

/**
 * Core request handling (pure, no req/res I/O): validate the parsed request,
 * check the API key, call Gemini, and map to an {status, body} HTTP result.
 */
export async function handleRequest(
  request: unknown,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  if (!isProxyRequest(request)) {
    return { status: 400, body: { error: 'invalid_request' } };
  }
  if (!apiKey) {
    return { status: 500, body: { error: 'missing_api_key' } };
  }
  const result = await summarizeWithGemini(request, apiKey, fetchImpl);
  if (!result.ok) {
    // 502 keeps the stable `error` code; `reason` + `gemini_status` are added
    // for diagnosis only (safe: a status code, never the key or Gemini's body).
    return {
      status: 502,
      body: {
        error: 'malformed_model_response',
        reason: result.reason,
        gemini_status: result.upstreamStatus,
      },
    };
  }
  return { status: 200, body: result.data };
}

/** Apply the CORS headers required by the extension (per the locked contract). */
export function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Collect the raw request body from a Node stream. Coerces string/Uint8Array
 *  chunks to Buffer (a real IncomingMessage emits Buffers; be defensive). */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string | Uint8Array) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array | string));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write a JSON result to the response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Vercel Node serverless handler. Typed with Node http types (no @vercel/node
 * dep needed). Handles CORS preflight, validates the request, calls Gemini, and
 * returns the structured summary or a typed error.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_body' });
    return;
  }

  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const result = await handleRequest(request, process.env.GEMINI_API_KEY, fetch);
  sendJson(res, result.status, result.body);
}
