// RTINGS source adapter (Pilar 2 — external opinions). SERVER-SIDE ONLY.
//
// The extension cannot fetch rtings.com directly (CORS + it would need a broad
// host_permission). So this adapter runs in the proxy: given a ProductQuery
// (brand/model/title from the ML PDP) it (1) searches RTINGS, (2) picks the best
// candidate with a CONSERVATIVE confidence gate, and (3) parses that review page
// into a NormalizedAnalysis the summary engine can consume.
//
// SCOPE (locked decision): HEADPHONES ONLY for now. A query that does not look
// like headphones is rejected up front (no RTINGS lookup) so we never surface a
// mismatched analysis. Adding a category later = a new adapter in the registry.
//
// MATCHING (locked decision): CONSERVATIVE. We compute a Jaccard token overlap
// between the ML product tokens and the RTINGS candidate title; below
// RTINGS_MATCH_THRESHOLD we return productMatched:false (honest "no data")
// rather than risk showing the lab analysis of the WRONG product.
//
// DATA SOURCE: we read the page's schema.org JSON-LD `Product` block (stable,
// NOT behind RTINGS' paywall): name, brand, the 0..10 expert rating (normalized
// to 0..5 here), and the editorial reviewBody. Numeric per-test scores on the
// page are paywall-blurred (`e-blurred`, value "0.0") so they are intentionally
// NOT scraped. Every parse is defensive: any failure yields productMatched:false
// instead of throwing.

/** A product identity used to look a product up on RTINGS. Mirror of the extension type. */
export type ProductQuery = {
  brand?: string;
  model?: string;
  title?: string;
  gtin?: string;
};

/** A review normalized to the engine's shape (rating ALWAYS on a 0..5 scale). */
export type NormalizedReview = {
  rating: number | null;
  text: string;
  date?: string;
  kind?: 'user' | 'expert';
};

/** Normalized result of querying RTINGS for one product. */
export type NormalizedAnalysis = {
  sourceId: 'rtings';
  sourceLabel: string;
  sourceUrl?: string;
  productMatched: boolean;
  matchConfidence?: number;
  reviews: NormalizedReview[];
  scores?: { label: string; value: number; max: number }[];
  pros?: string[];
  cons?: string[];
};

export const RTINGS_SOURCE_ID = 'rtings' as const;
export const RTINGS_LABEL = 'RTINGS';
/** Conservative match gate: below this Jaccard overlap -> treat as "no data". */
export const RTINGS_MATCH_THRESHOLD = 0.8;
/** RTINGS review-page URL fragment that scopes results to headphones. */
const HEADPHONES_PATH = '/headphones/reviews/';
const RTINGS_ORIGIN = 'https://www.rtings.com';
/** A real browser UA: RTINGS' edge may reject obvious bot/no-UA requests. */
const RTINGS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Tokens stripped before matching: generic marketing/connectivity/category words
 * and Spanish color names that appear in ML titles but not (or inconsistently)
 * in RTINGS titles. Removing them keeps the comparison on the BRAND + MODEL
 * tokens that actually identify the product. `audio` is included because it is a
 * generic word inside several brand names (e.g. "JLab Audio") and ML routinely
 * omits it, which would otherwise depress an otherwise-perfect match.
 */
const STOPWORDS = new Set([
  // category / form factor
  'headphones', 'headphone', 'earbuds', 'earbud', 'earphones', 'earphone',
  'audifonos', 'auriculares', 'audifono', 'auricular', 'audio',
  // connectivity / marketing
  'true', 'truly', 'wireless', 'inalambrico', 'inalambricos', 'inalambrica', 'inalambricas',
  'bluetooth', 'with', 'con', 'de', 'para', 'the', 'and', 'y',
  'review', 'original', 'nuevo', 'nueva',
  // MercadoLibre seller / listing boilerplate
  'color', 'cancelacion', 'cancelacia', 'cancellation', 'ruido', 'noise', 'distribuidor',
  'autorizado', 'authorized', 'oficial', 'official', 'tienda',
  // colors (es/en)
  'negro', 'negra', 'blanco', 'blanca', 'azul', 'rojo', 'roja', 'verde',
  'gris', 'rosa', 'rosado', 'morado', 'violeta', 'amarillo', 'dorado', 'plata',
  'plateado', 'black', 'white', 'blue', 'red', 'green', 'gray', 'grey', 'pink',
]);

/** Words that signal the ML product is headphones (scope gate). */
const HEADPHONE_HINTS = [
  'audifono', 'audifonos', 'auricular', 'auriculares', 'earbud', 'earbuds',
  'earphone', 'earphones', 'headphone', 'headphones', 'in-ear', 'on-ear',
  'over-ear',
];

/** Lowercase, strip accents/diacritics, drop punctuation. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Significant tokens of a string: normalized, split, stopwords + 1-char dropped. */
export function significantTokens(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => (t.length > 1 || /^\d$/.test(t)) && !STOPWORDS.has(t));
}

/** Build the brand+model+title token bag for a query. */
function queryTokens(query: ProductQuery): string[] {
  const parts = [query.brand, query.model, query.title].filter(Boolean).join(' ');
  return unique(significantTokens(parts));
}

function unique(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Jaccard overlap (|A∩B| / |A∪B|) of the significant tokens of the query vs a
 * RTINGS candidate title. Symmetric, so it penalizes BOTH missing query tokens
 * AND extra candidate tokens (a different/superset model scores lower) — exactly
 * the conservative behavior we want. Returns 0 when either side has no tokens.
 */
export function matchConfidence(query: ProductQuery, candidateTitle: string): number {
  const a = queryTokens(query);
  const b = unique(significantTokens(candidateTitle));
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const intersection = a.filter((t) => setB.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/** True when the ML query looks like headphones (scope gate for this adapter). */
export function looksLikeHeadphones(query: ProductQuery): boolean {
  const hay = normalizeText([query.title, query.model, query.brand].filter(Boolean).join(' '));
  return HEADPHONE_HINTS.some((h) => hay.includes(normalizeText(h)));
}

/** Build the RTINGS search URL for a query (headphones tools page search). */
export function buildSearchUrl(query: ProductQuery): string {
  const q = [query.brand, query.model].filter(Boolean).join(' ').trim() || query.title || '';
  return `${RTINGS_ORIGIN}/search?q=${encodeURIComponent(q)}`;
}

/** A RTINGS search candidate: a review URL + its visible title. */
export type SearchCandidate = { url: string; title: string };

/** RTINGS internal search API endpoint used by the current Vue search page. */
const RTINGS_SEARCH_API = `${RTINGS_ORIGIN}/api/v2/safe/app/search__search_results`;

type SearchApiResult = {
  title?: unknown;
  url?: unknown;
  page_type?: unknown;
};

/**
 * Parse headphones review candidates from a RTINGS search results page. Best
 * effort + defensive: collects anchors whose href points at a headphones review
 * (`/headphones/reviews/<brand>/<model>`) and uses the anchor's text (tags
 * stripped) as the title. Deduped by URL. Never throws.
 */
export function parseSearchResults(html: string, baseOrigin: string = RTINGS_ORIGIN): SearchCandidate[] {
  const out: SearchCandidate[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href="([^"]*\/headphones\/reviews\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const title = stripTags(m[2]);
    // Require a brand/model segment (…/reviews/<brand>/<model>), not the hub page.
    const path = href.replace(/^https?:\/\/[^/]+/, '');
    const segments = path.split('/').filter(Boolean); // ['headphones','reviews','brand','model']
    if (segments.length < 4) continue;
    const url = href.startsWith('http') ? href : baseOrigin + href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title });
  }
  return out;
}

/**
 * Parse candidates from RTINGS' current internal search API response.
 * The public `/search` page is Vue-rendered, so results no longer appear as
 * plain anchors in the HTML. This keeps the old HTML parser as a fallback but
 * makes the adapter work with the real production search path.
 */
export function parseSearchApiResults(json: unknown, baseOrigin: string = RTINGS_ORIGIN): SearchCandidate[] {
  const results = (((json as Record<string, unknown> | null)?.data as Record<string, unknown> | undefined)
    ?.search_results as Record<string, unknown> | undefined)?.results;
  if (!Array.isArray(results)) return [];

  const out: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of results as SearchApiResult[]) {
    if (raw == null || typeof raw !== 'object') continue;
    if (raw.page_type !== 'review') continue;
    if (typeof raw.url !== 'string' || typeof raw.title !== 'string') continue;
    if (!raw.url.includes(HEADPHONES_PATH)) continue;
    const url = raw.url.startsWith('http') ? raw.url : baseOrigin + raw.url;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: decodeEntities(stripTags(raw.title)) });
  }
  return out;
}

/** Remove HTML tags + collapse whitespace + decode a few common entities. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Decode the handful of HTML entities RTINGS emits in titles/text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, d) => safeFromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCharCode(parseInt(h, 16)));
}

function safeFromCharCode(code: number): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
}

/** Minimal schema.org Product/Review shape we read from JSON-LD. */
type JsonLdProduct = {
  '@type'?: string;
  name?: string;
  brand?: { name?: string } | string;
  review?: {
    reviewRating?: { ratingValue?: string | number; bestRating?: string | number };
    reviewBody?: string;
    datePublished?: string;
  };
};

/** Extract and JSON-parse every <script type="application/ld+json"> block. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      // ignore a malformed block; other blocks may still be valid
    }
  }
  return out;
}

/** Find the schema.org Product block among parsed JSON-LD entries. */
function findProductLd(blocks: unknown[]): JsonLdProduct | null {
  for (const b of blocks) {
    if (b && typeof b === 'object' && (b as JsonLdProduct)['@type'] === 'Product') {
      return b as JsonLdProduct;
    }
  }
  return null;
}

/** Read a numeric value from a string|number JSON-LD field. */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Pull the og/meta description as a reviewBody fallback. */
function metaDescription(html: string): string | null {
  const m =
    /<meta\b[^>]*(?:name="description"|property="og:description")[^>]*content="([^"]*)"/i.exec(html) ||
    /<meta\b[^>]*content="([^"]*)"[^>]*(?:name="description"|property="og:description")/i.exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** Pull a usable page title from og:title or <title>. */
function metaTitle(html: string): string | null {
  const m =
    /<meta\b[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html) ||
    /<meta\b[^>]*content="([^"]*)"[^>]*property="og:title"/i.exec(html) ||
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(stripTags(m[1])).replace(/\s+-\s+RTINGS\.com$/i, '').trim() : null;
}

/** Pull the canonical URL of the review page. */
function canonicalUrl(html: string): string | null {
  const m = /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

/**
 * Parse a RTINGS headphones review page into a NormalizedAnalysis. Reads the
 * schema.org JSON-LD Product (stable, non-paywalled): product name, brand, the
 * 0..10 expert rating normalized to 0..5, and the editorial reviewBody (falling
 * back to the meta description). The single expert review carries kind:'expert'.
 * Returns productMatched:false (rather than throwing) when no Product block with
 * a usable name is present. `pageUrl` overrides the canonical link when known.
 */
export function parseReviewPage(html: string, pageUrl?: string): NormalizedAnalysis {
  const product = findProductLd(extractJsonLdBlocks(html));
  const url = pageUrl ?? canonicalUrl(html) ?? undefined;
  const empty: NormalizedAnalysis = {
    sourceId: RTINGS_SOURCE_ID,
    sourceLabel: RTINGS_LABEL,
    sourceUrl: url,
    productMatched: false,
    reviews: [],
  };
  if (!product || typeof product.name !== 'string' || product.name.trim().length === 0) {
    const title = metaTitle(html);
    const description = metaDescription(html);
    if (!title || !description) return empty;
    return {
      sourceId: RTINGS_SOURCE_ID,
      sourceLabel: RTINGS_LABEL,
      sourceUrl: url,
      productMatched: true,
      reviews: [{ rating: null, text: `${title}. ${description}`, kind: 'expert' }],
    };
  }

  const brandName = typeof product.brand === 'object' ? product.brand?.name : product.brand;
  const review = product.review ?? {};
  const ratingValue = num(review.reviewRating?.ratingValue);
  const bestRating = num(review.reviewRating?.bestRating) ?? 10;
  // Normalize the expert score to the engine's 0..5 scale.
  const rating =
    ratingValue != null && bestRating > 0
      ? Math.round((ratingValue / bestRating) * 5 * 10) / 10
      : null;

  const body = (typeof review.reviewBody === 'string' && review.reviewBody.trim()) || metaDescription(html) || '';
  const text = decodeEntities(body).trim();
  if (text.length === 0) {
    // A Product block with no usable editorial text is not summarizable.
    return { ...empty, productMatched: false };
  }

  const expert: NormalizedReview = {
    rating,
    text,
    kind: 'expert',
    ...(review.datePublished ? { date: String(review.datePublished).slice(0, 10) } : {}),
  };

  return {
    sourceId: RTINGS_SOURCE_ID,
    sourceLabel: brandName ? `${RTINGS_LABEL}` : RTINGS_LABEL,
    sourceUrl: url,
    productMatched: true,
    reviews: [expert],
  };
}

/** A no-match analysis with the given confidence (for the fallback UI state). */
function noMatch(confidence?: number): NormalizedAnalysis {
  return {
    sourceId: RTINGS_SOURCE_ID,
    sourceLabel: RTINGS_LABEL,
    productMatched: false,
    ...(confidence != null ? { matchConfidence: confidence } : {}),
    reviews: [],
  };
}

async function getText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': RTINGS_UA, Accept: 'text/html' } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function getSearchApiCandidates(query: ProductQuery, fetchImpl: typeof fetch): Promise<SearchCandidate[]> {
  try {
    const variables = {
      query: [query.brand, query.model].filter(Boolean).join(' ').trim() || query.title || '',
      type: 'full',
      is_admin: false,
      count: 20,
      silo_url_part: ['headphones'],
      offset: 0,
      page_type: ['review'],
      brand: null,
      release_year: null,
      methodology: null,
    };
    const res = await fetchImpl(RTINGS_SEARCH_API, {
      method: 'POST',
      headers: {
        'User-Agent': RTINGS_UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: buildSearchUrl(query),
      },
      body: JSON.stringify({ variables }),
    });
    if (!res.ok) return [];
    return parseSearchApiResults(await res.json());
  } catch {
    return [];
  }
}

/**
 * Look a product up on RTINGS and return a NormalizedAnalysis. Flow:
 *   scope gate (headphones?) -> search -> pick best candidate by confidence ->
 *   conservative threshold gate -> fetch + parse the review page.
 * Every failure path returns productMatched:false (never throws) so the proxy
 * can render the honest "no data" fallback. `fetchImpl` is injectable for tests.
 */
export async function fetchAnalysis(
  query: ProductQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedAnalysis> {
  // Scope gate: this adapter only covers headphones. A non-headphones product
  // never triggers a RTINGS lookup (avoids surfacing an unrelated analysis).
  if (!looksLikeHeadphones(query)) return noMatch();

  let candidates = await getSearchApiCandidates(query, fetchImpl);
  if (candidates.length === 0) {
    const searchHtml = await getText(buildSearchUrl(query), fetchImpl);
    if (!searchHtml) return noMatch();
    candidates = parseSearchResults(searchHtml);
  }
  if (candidates.length === 0) return noMatch();

  // Pick the highest-confidence candidate.
  let best: SearchCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = matchConfidence(query, c.title);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  // Conservative gate: below the threshold we report "no data" rather than risk
  // showing the wrong product's lab analysis.
  if (!best || bestScore < RTINGS_MATCH_THRESHOLD) return noMatch(bestScore);

  const reviewHtml = await getText(best.url, fetchImpl);
  if (!reviewHtml) return noMatch(bestScore);

  const analysis = parseReviewPage(reviewHtml, best.url);
  // Carry the computed confidence through for diagnostics / UI.
  return { ...analysis, matchConfidence: bestScore };
}
