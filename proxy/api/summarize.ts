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
import type { ProductQuery, NormalizedReview, NormalizedAnalysis } from './sources/rtings.js';

/** Mirror of extension ReviewText/ProxyRequest/ProxyResponse (see header). */
type SourceId = 'ml-internal' | 'rtings' | (string & {});
type ReviewText = { rating: number | null; text: string; date?: string };
type ProxyRequest = {
  source?: SourceId;
  productId: string;
  productTitle: string;
  locale?: string;
  reviews?: ReviewText[];
  productQuery?: ProductQuery;
};
type SourceMeta = { sourceId: SourceId; label: string; url?: string; matched: boolean };
type ProxyResponse = { strongPoints: string[]; weakPoints: string[]; verdict: string; sourceMeta?: SourceMeta };
type ServerSourceAdapter = {
  id: string;
  label: string;
  fetchAnalysis(query: ProductQuery, fetchImpl?: typeof fetch): Promise<NormalizedAnalysis>;
};

/** Default source when a request omits it (back-compat with ml-internal callers). */
const DEFAULT_SOURCE: SourceId = 'ml-internal';

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

/**
 * Defensive caps to bound proxy cost + memory (Pilar 2 quota safety). The team
 * is quota-constrained on Gemini, so anything that wastes a call is high-
 * impact: reject empty/oversize payloads BEFORE they reach the model.
 */
const MAX_REVIEWS = 100;
const MAX_REVIEW_CHARS = 4000;
/**
 * Maximum accepted raw body size. COHERENT with the per-field caps: a legit
 * payload at the cap (MAX_REVIEWS * MAX_REVIEW_CHARS ~ 400KB of review text,
 * plus JSON overhead + product context) fits comfortably under 512KB. The
 * body cap guards readBody from unbounded streams (DoS / memory); the
 * per-field caps (enforced POST-parse, by count rejection + text truncation)
 * bound what actually reaches Gemini. The previous 256KB cap rejected a
 * within-caps payload as body_too_large before it could be parsed.
 */
const MAX_BODY_BYTES = 512 * 1024;

/** JSON HTTP response helper body. */
type HttpResult = { status: number; body: unknown };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing with a mocked fetch / fake streams).
// ---------------------------------------------------------------------------

/** Build the Gemini REST request URL + headers + JSON body for a ProxyRequest. */
export function buildGeminiRequest(request: ProxyRequest, apiKey: string, expert = false): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const prompt = buildPrompt(request, expert);
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

/**
 * Compose the Spanish summarization prompt from product context + reviews. When
 * `expert` is true the reviews are editorial/expert analyses (e.g. RTINGS lab
 * reviews) rather than user opinions, so the framing is adapted accordingly; the
 * required JSON output shape is identical for both.
 */
export function buildPrompt(request: ProxyRequest, expert = false): string {
  const reviews = request.reviews ?? [];
  const reviewLines = reviews.map((r, i) => {
    const rating = r.rating != null ? ` (estrellas: ${r.rating})` : '';
    const date = r.date ? ` [${r.date}]` : '';
    return `${i + 1}. ${r.text}${rating}${date}`;
  });
  const intro = expert
    ? `Sos un asistente que resume análisis técnicos de expertos (por ejemplo de RTINGS) sobre productos.`
    : `Sos un asistente que resume opiniones de productos de MercadoLibre.`;
  const sourceLabel = expert ? `Análisis de expertos:` : `Opiniones:`;
  return [
    intro,
    `Producto: ${request.productTitle}.`,
    sourceLabel,
    reviewLines.join('\n'),
    ``,
    `Resumí ${expert ? 'el análisis' : 'las opiniones'} en JSON con tres campos:`,
    `- strongPoints: lista de strings con los puntos a favor.`,
    `- weakPoints: lista de strings con los puntos en contra / defectos.`,
    `- verdict: un veredicto breve y claro sobre el producto.`,
    `Respondé SOLO el JSON, sin texto adicional.`,
  ].join('\n');
}

/**
 * Structural guard for an incoming ProxyRequest. Defensive caps bound the
 * proxy cost; the empty-reviews / empty-text cases are rejected because
 * `.every` on an empty array is true (a direct caller could otherwise trigger
 * a real Gemini call with an empty prompt and waste a quota unit).
 *
 * The COUNT cap (MAX_REVIEWS) is enforced here (reject). The per-review TEXT
 * LENGTH cap (MAX_REVIEW_CHARS) is NOT enforced here: a single over-long
 * review is TRUNCATED post-validation (see truncateReviews) rather than
 * failing the whole summary. Empty/whitespace text is still rejected.
 */
export function isProxyRequest(value: unknown): value is ProxyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.productId !== 'string' || !r.productId) return false;
  if (typeof r.productTitle !== 'string') return false;

  // `source` is optional and defaults to ml-internal (back-compat). An external
  // source carries a productQuery (the proxy fetches the source) instead of
  // inline reviews; ml-internal carries the extracted reviews.
  const source = (typeof r.source === 'string' && r.source) || DEFAULT_SOURCE;
  if (source !== DEFAULT_SOURCE) {
    return isValidProductQuery(r.productQuery);
  }

  if (!Array.isArray(r.reviews)) return false;
  if (r.reviews.length === 0) return false; // require at least one review
  if (r.reviews.length > MAX_REVIEWS) return false; // defensive count cap
  return r.reviews.every((rv) => {
    if (!rv || typeof rv !== 'object') return false;
    const v = rv as Record<string, unknown>;
    if (typeof v.text !== 'string') return false;
    if (v.text.trim().length === 0) return false; // reject empty body text
    // NOTE: over-long text is NOT rejected here — truncated post-validation.
    return v.rating === null || typeof v.rating === 'number';
  });
}

/** An external request needs a productQuery with at least a brand, model, or title. */
function isValidProductQuery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  const hasField = (k: string) => typeof q[k] === 'string' && (q[k] as string).trim().length > 0;
  return hasField('brand') || hasField('model') || hasField('title');
}

/**
 * Cap each review's text to MAX_REVIEW_CHARS (defensive, post-validation). A
 * single over-long review is TRUNCATED rather than failing the whole summary
 * (the count cap + empty-text checks still reject in isProxyRequest). Returns
 * a shallow-copied request with truncated review texts so the original is not
 * mutated.
 */
export function truncateReviews(request: ProxyRequest): ProxyRequest & { reviews: ReviewText[] } {
  return {
    ...request,
    reviews: (request.reviews ?? []).map((r) =>
      r.text.length > MAX_REVIEW_CHARS ? { ...r, text: r.text.slice(0, MAX_REVIEW_CHARS) } : r,
    ),
  };
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
  expert = false,
): Promise<GeminiOutcome> {
  const { url, headers, body } = buildGeminiRequest(request, apiKey, expert);
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
/** Map an adapter's NormalizedReview to the proxy ReviewText prompt shape. */
function toReviewText(r: NormalizedReview): ReviewText {
  return { rating: r.rating, text: r.text, ...(r.date ? { date: r.date } : {}) };
}

/**
 * Load external-source adapters lazily.
 *
 * Keep this out of the module top-level: a Vercel/runtime resolution issue in
 * an optional adapter must not crash the whole summarize function, especially
 * the default Mercado Libre path and CORS preflight.
 */
async function getExternalAdapter(source: SourceId): Promise<ServerSourceAdapter | undefined> {
  try {
    const registry = await import('./sources/registry.js');
    return registry.getServerAdapter(source);
  } catch {
    return undefined;
  }
}

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

  const source: SourceId = request.source ?? DEFAULT_SOURCE;

  // External source (e.g. RTINGS): fetch + normalize SERVER-SIDE, then summarize
  // the editorial analysis. A no-match returns a 200 marker body the extension
  // renders as the "no data" fallback (NOT an error — the request was valid).
  let expert = false;
  let toSummarize: ProxyRequest = request;
  let sourceMeta: SourceMeta | undefined;
  if (source !== DEFAULT_SOURCE) {
    const adapter = await getExternalAdapter(source);
    if (!adapter) {
      return { status: 400, body: { error: 'unsupported_source' } };
    }
    let analysis: NormalizedAnalysis;
    try {
      analysis = await adapter.fetchAnalysis(request.productQuery ?? {}, fetchImpl);
    } catch {
      // Adapter is defensive and should not throw, but never let it 500 the proxy.
      analysis = { sourceId: source as 'rtings', sourceLabel: adapter.label, productMatched: false, reviews: [] };
    }
    sourceMeta = {
      sourceId: source,
      label: adapter.label,
      ...(analysis.sourceUrl ? { url: analysis.sourceUrl } : {}),
      matched: analysis.productMatched,
    };
    if (!analysis.productMatched || analysis.reviews.length === 0) {
      return { status: 200, body: { error: 'no_source_data', sourceMeta } };
    }
    expert = analysis.reviews.some((r) => r.kind === 'expert');
    toSummarize = { ...request, reviews: analysis.reviews.map(toReviewText) };
  }

  // Truncate over-long review texts post-validation (a single long review
  // never fails the whole summary; the count cap + empty-text already rejected).
  const normalized = truncateReviews(toSummarize);
  const result = await summarizeWithGemini(normalized, apiKey, fetchImpl, expert);
  if (!result.ok) {
    // A Gemini 429 (rate limit / quota) is propagated AS 429 so the extension
    // can render its polished "límite de uso" state instead of a raw 5xx. Every
    // other upstream failure maps to 502 with `reason` + `gemini_status` for
    // diagnosis (safe: just a status code, never the key or Gemini's body).
    if (result.reason === 'http_error' && result.upstreamStatus === 429) {
      return { status: 429, body: { error: 'rate_limited', gemini_status: 429 } };
    }
    return {
      status: 502,
      body: {
        error: 'malformed_model_response',
        reason: result.reason,
        gemini_status: result.upstreamStatus,
      },
    };
  }
  // Attach sourceMeta only for external sources so the ml-internal contract is
  // byte-for-byte unchanged (existing clients + tests see exactly the summary).
  const body: ProxyResponse = sourceMeta ? { ...result.data, sourceMeta } : result.data;
  return { status: 200, body };
}

/**
 * Apply the CORS headers required by the extension (per the locked contract),
 * with a FIXED ORIGIN ALLOW-LIST so the paid Gemini key is not drainable by any
 * website. The legitimate caller is a content script on MercadoLibre pages,
 * whose `Origin` header is one of the real ML/MercadoLivre hosts below (or a
 * subdomain thereof — matches the manifest `matches` list).
 *
 * Reflection rules:
 *   - Origin matches an allowed ML host -> reflect that exact origin.
 *   - Origin header absent                  -> curl / server-to-server: keep the
 *                                              wildcard so tooling is not broken.
 *   - Origin present but NOT an allowed host -> omit Access-Control-Allow-Origin
 *      AND the handler returns 403 (forbidden_origin) before Gemini (see
 *      handler) so a browser cannot drain quota with foreign-origin POSTs.
 *
 * `Vary: Origin` is set UNCONDITIONALLY (every branch) so shared / CDN caches
 * can never replay a wildcard or reflected response to a foreign-origin caller.
 */
export function applyCors(res: ServerResponse, origin: string | undefined): void {
  // Unconditional: caches must vary on Origin regardless of the branch taken,
  // otherwise a wildcard response can be replayed to a foreign-origin browser.
  res.setHeader('Vary', 'Origin');
  if (origin) {
    if (isMercadoLibreOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // Foreign origin: omit Access-Control-Allow-Origin; the handler also 403s.
  } else {
    // No Origin header (curl / server-to-server): keep the permissive wildcard
    // so non-browser tooling keeps working. Browser cross-origin requests
    // always send Origin, so this does not open the proxy to browser abuse.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Fixed allow-list of real MercadoLibre / MercadoLivre hosts. The host must be
 * EXACTLY one of these, or a subdomain thereof (e.g. `www.`, `articulo.`,
 * `listado.`). Mirrors the manifest `matches` list
 * (extension/src/manifest-data.ts) PLUS `mercadolivre.com.br` (Brazil uses the
 * "mercadoliVRE" spelling). A regex / any-TLD match is deliberately NOT used so
 * look-alike TLDs (`mercadolibre.xyz`) are not reflected.
 */
const ML_ALLOWED_HOSTS: ReadonlyArray<string> = [
  'mercadolibre.com.ar',
  'mercadolibre.com.mx',
  'mercadolibre.com.br',
  'mercadolibre.com',
  'mercadolibre.cl',
  'mercadolibre.com.co',
  'mercadolibre.com.uy',
  'mercadolibre.com.pe',
  'mercadolibre.com.ve',
  'mercadolibre.com.ec',
  'mercadolibre.com.bo',
  'mercadolibre.com.py',
  'mercadolibre.com.do',
  'mercadolibre.com.cr',
  'mercadolibre.com.gt',
  'mercadolibre.co',
  'mercadolivre.com.br', // Brazil: "mercadoliVRE"
];

/**
 * True when `origin` is a MercadoLibre / MercadoLivre origin: the host is
 * exactly one of `ML_ALLOWED_HOSTS` or a subdomain of one (`.host` suffix). The
 * leading dot in the suffix check prevents prefix attacks (`evilmercadolibre.com`
 * does not match `.mercadolibre.com`). Used for CORS reflection AND the 403
 * forbidden-origin guard in the handler.
 */
export function isMercadoLibreOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return ML_ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
  } catch {
    return false;
  }
}

/**
 * Collect the raw request body from a Node stream. Coerces string/Uint8Array
 * chunks to Buffer (a real IncomingMessage emits Buffers; be defensive). Enforces
 * a max body size (MAX_BODY_BYTES, 512KB): if the stream exceeds it, the promise
 * rejects with `body_too_large` and the stream is destroyed so further chunks do
 * not buffer — the handler maps this to a 413 BEFORE parsing or calling Gemini.
 */
export function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (c: Buffer | string | Uint8Array) => {
      if (rejected) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array | string);
      total += buf.length;
      if (total > maxBytes) {
        rejected = true;
        reject(new Error('body_too_large'));
        // Stop reading: destroy the stream if available so further chunks don't buffer.
        const destroyable = req as unknown as { destroy?: () => void };
        if (typeof destroyable.destroy === 'function') destroyable.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err: unknown) => {
      if (!rejected) reject(err);
    });
  });
}

/** Write a JSON result to the response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Vercel Node serverless handler. Typed with Node http types (no @vercel/node
 * dep needed). Handles CORS preflight, the origin allow-list guard, validates
 * the request, calls Gemini, and returns the structured summary or a typed error.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS reflection is based on the request Origin (fixed allow-list). An
  // absent Origin (curl / server-to-server) is allowed with the wildcard so
  // tooling keeps working; a PRESENT but not-allowed Origin is rejected with
  // 403 below BEFORE the body is read or Gemini is called (browser quota-drain
  // closure — a foreign website cannot POST to the proxy and burn quota).
  const origin = getRequestOrigin(req);
  applyCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Server-side origin guard: a browser request whose Origin is present but NOT
  // an allowed MercadoLibre origin is forbidden BEFORE readBody / Gemini. An
  // absent Origin (curl / server-to-server) is still allowed.
  if (origin && !isMercadoLibreOrigin(origin)) {
    sendJson(res, 403, { error: 'forbidden_origin' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    // readBody rejects with `body_too_large` when the stream exceeds the cap;
    // map that to 413 so the client can distinguish it from a malformed body.
    if (e instanceof Error && e.message === 'body_too_large') {
      sendJson(res, 413, { error: 'body_too_large' });
    } else {
      sendJson(res, 400, { error: 'invalid_body' });
    }
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

/** Read the request `Origin` header (case-insensitive) as a string or undefined. */
function getRequestOrigin(req: IncomingMessage): string | undefined {
  // Node lowercases header names, but be defensive against proxies that don't.
  const raw =
    (req.headers.origin as string | string[] | undefined) ??
    (req.headers.Origin as string | string[] | undefined);
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
