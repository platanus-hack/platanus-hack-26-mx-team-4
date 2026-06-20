// PDP adapter — the ONLY file that touches MercadoLibre product-detail-page
// selectors (Pilar 2). Mirrors the Pilar 1 pattern: selectors live ONLY here.
//
// STATUS — SELECTORS FROZEN from a captured live PDP fixture
// (tests/fixtures/ml-pdp-ar.html, a real ML PDP saved via browser "Save Page
// As"). ML renders the featured reviews inline with the `ui-review-capability`
// component (NOT Next.js — the page hydrates from `__NORDIC_RENDERING_CTX__`,
// which the generic `#__NEXT_DATA__` scan intentionally ignores). So the
// hydration path is a no-op here and extraction runs through the DOM path with
// the frozen selectors below.
//   - Reviews: `.ui-review-capability-comments__comment` items, body text in
//     `__content`, rating rendered as filled star SVGs (`<use href="#poly_star_
//     fill">`) which we COUNT to get the numeric rating.
//   - The per-review `__date` element holds the reviewer COUNTRY, not a date,
//     so REVIEW_DATE_SELECTOR is left empty (date stays optional/undefined
//     rather than carrying garbage).
//   - `hasMoreReviewsHint` is wired to the "Mostrar todas las opiniones"
//     control (`.show-more-click`).
//   The CONTRACT is unchanged and tested: extractDetail NEVER throws and always
//   returns a ProductReviewData (empty partial when nothing is found).

import type { ProductReviewData, ReviewText } from '../detail/types';

// ---------------------------------------------------------------------------
// Selectors FROZEN against the captured live PDP fixture (tests/fixtures/
// ml-pdp-ar.html). Empty selectors are still guarded (`querySelector('')`
// throws SyntaxError), so REVIEW_DATE_SELECTOR='' is safely skipped.
// ---------------------------------------------------------------------------
const REVIEW_CONTAINER_SELECTOR = '.ui-review-capability-comments'; // reviews wrapper
const REVIEW_ITEM_SELECTOR = '.ui-review-capability-comments__comment'; // one review (article)
const REVIEW_TEXT_SELECTOR = '.ui-review-capability-comments__comment__content'; // review body text
const REVIEW_RATING_SELECTOR = '.ui-review-capability-comments__comment__rating'; // star container (count fills)
const REVIEW_DATE_SELECTOR = ''; // intentionally empty: ML's __date holds the country, not a date
const PRODUCT_TITLE_SELECTOR = '.ui-pdp-title'; // PDP title
const MORE_REVIEWS_HINT_SELECTOR = '.show-more-click'; // "Mostrar todas las opiniones" control

/** True when a selector string is usable (non-empty). Guards querySelector. */
function hasSelector(sel: string): boolean {
  return sel.trim().length > 0;
}

/** querySelectorAll that is safe for an empty/TBD selector (returns []). */
function safeQueryAll(root: ParentNode, sel: string): Element[] {
  if (!hasSelector(sel)) return [];
  try {
    return Array.from(root.querySelectorAll(sel));
  } catch {
    // Malformed selector -> treat as "not found" rather than crashing the page.
    return [];
  }
}

/** querySelector that is safe for an empty/TBD selector (returns null). */
function safeQuery<T extends Element>(root: ParentNode, sel: string): T | null {
  if (!hasSelector(sel)) return null;
  try {
    return root.querySelector<T>(sel);
  } catch {
    return null;
  }
}

/**
 * Extract review context from a PDP document. Hydration-JSON first (Next.js
 * `#__NEXT_DATA__`), DOM-fallback second (selectors TBD). NEVER throws: on any
 * error or missing data it returns an empty partial so the pipeline can render
 * the empty state instead of crashing.
 *
 * Accepts an optional `doc` + `url` so adapter tests can pass a JSDOM instance
 * parsed from a fixture; production calls with no argument and it defaults to
 * the live global `document` / `location`.
 */
export function extractDetail(
  doc: Document = document,
  url: string = typeof location !== 'undefined' ? location.href : '',
): ProductReviewData {
  const productId = parseProductId(url, doc);
  const productTitle = parseProductTitle(doc);

  try {
    const hydrated = extractFromHydration(doc);
    if (hydrated.reviews.length > 0) {
      return {
        productId,
        productTitle,
        reviews: hydrated.reviews,
        hasMoreReviewsHint: detectMoreHint(doc),
      };
    }
  } catch {
    // Hydration parse failure is non-fatal — fall through to the DOM path.
  }

  // DOM fallback. Inert until SELECTOR TBD constants are filled from a fixture.
  const reviews = extractReviewsFromDom(doc);
  return {
    productId,
    productTitle,
    reviews,
    hasMoreReviewsHint: detectMoreHint(doc),
  };
}

/**
 * Parse the ML item id from the PDP URL path, falling back to a meta tag, then
 * to the path. ML country prefixes vary: MLA (AR), MLB (BR), MLC (CL), MLM (MX),
 * MLU (UY), MLV (VE), MCO (CO), MPE (PE), MEC (EC) — all match `M` + 1-3
 * letters + digits. Scanning the PATH only avoids host false positives
 * (e.g. `mlstatic.com`, `mercadolibre`).
 */
function parseProductId(url: string, doc: Document): string {
  const ID_RE = /M[A-Z]{1,3}\d+/i;
  try {
    const match = new URL(url).pathname.match(ID_RE);
    if (match) return match[0].toUpperCase();
  } catch {
    // not an absolute URL — try the raw string as a last resort
    const match = url.match(ID_RE);
    if (match) return match[0].toUpperCase();
  }
  // Generic fallback: <meta itemprop="productID"> if present.
  const meta = safeQuery<HTMLMetaElement>(doc, 'meta[itemprop="productID"]');
  if (meta?.content) return meta.content;
  try {
    return new URL(url).pathname || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Product title from the DOM selector (TBD), else <h1>, else <title>. */
function parseProductTitle(doc: Document): string {
  const fromSelector = safeQuery<HTMLElement>(doc, PRODUCT_TITLE_SELECTOR);
  if (fromSelector?.textContent) return fromSelector.textContent.trim();
  const h1 = safeQuery<HTMLHeadingElement>(doc, 'h1');
  if (h1?.textContent) return h1.textContent.trim();
  return doc.title?.trim() || '';
}

/**
 * Hydration-first extraction: parse the Next.js `#__NEXT_DATA__` script and run
 * a shape-based finder for review-like objects. GENERIC and provisional — the
 * exact review node path must be confirmed against the captured fixture.
 */
function extractFromHydration(doc: Document): { reviews: ReviewText[] } {
  const script = safeQuery<HTMLScriptElement>(doc, '#__NEXT_DATA__');
  if (!script?.textContent) return { reviews: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(script.textContent);
  } catch {
    return { reviews: [] };
  }
  return { reviews: findReviewsInObject(payload) };
}

/**
 * Recursively walk a hydration object collecting items that look like reviews:
 * objects carrying a string `text`/`content`/`review`/`body` field, with an
 * optional numeric `rating`/`stars`/`value`. Bounded by depth + visit count so
 * a huge blob cannot hang the page. Best-effort; refine against the fixture.
 */
function findReviewsInObject(node: unknown, depth = 0): ReviewText[] {
  const MAX_DEPTH = 12;
  const MAX_VISITS = 20000;
  let visits = 0;
  const out: ReviewText[] = [];

  function walk(value: unknown, d: number): void {
    if (d > MAX_DEPTH || visits > MAX_VISITS) return;
    visits++;
    if (Array.isArray(value)) {
      // If this array's elements themselves look like reviews, harvest them and
      // do not descend further (avoids double-collecting nested duplicates).
      const harvested = harvestReviewsFromArray(value);
      if (harvested.length > 0) {
        out.push(...harvested);
        return;
      }
      for (const item of value) walk(item, d + 1);
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) walk(obj[key], d + 1);
    }
  }

  walk(node, depth);
  return out;
}

/** Turn an array of review-shaped objects into ReviewText[], ignoring non-matches. */
function harvestReviewsFromArray(arr: unknown[]): ReviewText[] {
  const reviews: ReviewText[] = [];
  for (const item of arr) {
    const r = asReview(item);
    if (r) reviews.push(r);
  }
  // Only accept the array as a review list if MOST elements matched the shape;
  // otherwise this was just a generic array and we should keep walking.
  if (arr.length > 0 && reviews.length / arr.length >= 0.5) return reviews;
  return [];
}

/** Map a hydration object to a ReviewText when it carries review-like fields. */
function asReview(value: unknown): ReviewText | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const text = pickString(obj, ['text', 'content', 'review', 'body', 'comment']);
  if (!text) return null;
  const rating = pickNumber(obj, ['rating', 'stars', 'value', 'rate']);
  const date = pickString(obj, ['date', 'createdAt', 'created_at', 'dateCreated']);
  return { rating, text, ...(date ? { date } : {}) };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** DOM-fallback review extraction. Inert until selectors are fixture-grounded. */
function extractReviewsFromDom(doc: Document): ReviewText[] {
  const container = safeQuery<HTMLElement>(doc, REVIEW_CONTAINER_SELECTOR);
  const root: ParentNode = container ?? doc;
  const items = safeQueryAll(root, REVIEW_ITEM_SELECTOR);
  if (items.length === 0) return [];
  const reviews = items.map((item) => {
    // Compute pickDate once per review (was called twice: condition + value).
    const date = pickDate(item);
    return {
      rating: parseRatingFromEl(item),
      text: textOf(safeQuery<HTMLElement>(item, REVIEW_TEXT_SELECTOR)),
      ...(date ? { date } : {}),
    };
  });
  // Filter out empty-text entries (rating-only reviews or a content-selector
  // miss). The hydration path (`asReview`) already requires non-empty text; keep
  // the DOM path consistent so the pipeline shows the empty state instead of
  // POSTing blank "1. " lines to the proxy (wasted Gemini call + poor summary).
  // If every matched item has empty text, return zero reviews.
  return reviews.filter((r) => r.text.trim().length > 0);
}

function parseRatingFromEl(item: Element): number | null {
  const el = safeQuery<HTMLElement>(item, REVIEW_RATING_SELECTOR);
  if (!el) return null;
  // ML renders the per-review rating as filled/empty star SVGs; a filled star
  // is a `<use href="#poly_star_fill">`. Count the filled ones to get 0..5.
  const stars = el.querySelectorAll('use');
  if (stars.length > 0) {
    const filled = Array.from(stars).filter((u) => /fill/i.test(u.getAttribute('href') ?? '')).length;
    return filled > 0 ? filled : null;
  }
  // Fallback for any layout that exposes a numeric rating as text instead.
  const n = parseFloat((el.textContent ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function pickDate(item: Element): string | undefined {
  const el = safeQuery<HTMLElement>(item, REVIEW_DATE_SELECTOR);
  const t = el?.textContent?.trim();
  return t || undefined;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

/**
 * Detect a "Mostrar todas las opiniones" / load-more reviews control. Wired to
 * the frozen `.show-more-click` selector from the fixture; the text heuristic is
 * kept only as a defensive fallback for layouts without that class.
 */
function detectMoreHint(doc: Document): boolean {
  if (hasSelector(MORE_REVIEWS_HINT_SELECTOR)) {
    return safeQuery<HTMLElement>(doc, MORE_REVIEWS_HINT_SELECTOR) !== null;
  }
  // Defensive text heuristic for layouts that lack the frozen control class.
  try {
    const candidates = Array.from(doc.querySelectorAll('button, a'));
    return candidates.some((el) => /ver\s+m[aá]s\s+opin/i.test(el.textContent ?? ''));
  } catch {
    return false;
  }
}
