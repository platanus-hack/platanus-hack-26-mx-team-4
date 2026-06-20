// PDP adapter — the ONLY file that touches MercadoLibre product-detail-page
// selectors (Pilar 2). Mirrors the Pilar 1 pattern: selectors live ONLY here.
//
// STATUS — SELECTORS NOT FROZEN (Batch 0 fixture precondition unmet):
//   Live PDP fixtures could NOT be captured in this environment (MercadoLibre
//   bot protection blocks server-side fetch; reviews are client-hydrated). Per
//   the spec, NO ML class selector may be frozen until a human captures a real
//   PDP via browser "Save Page As" into tests/fixtures/. Until then:
//     - The DOM-fallback selector constants below are EMPTY and GUARDED (an
//       empty selector is skipped, never passed to querySelector, which would
//       throw a SyntaxError). So the fallback contributes nothing yet.
//     - The hydration-JSON path uses a GENERIC Next.js `#__NEXT_DATA__` scan
//       with a shape-based review finder. It is best-effort and MUST be
//       confirmed/narrowed against the captured fixture (the exact review node
//       path is fixture-dependent and intentionally not hard-coded here).
//     - `hasMoreReviewsHint` returns false (TODO: wire to the fixture's "Ver
//       más" control once selectors are known).
//   The CONTRACT is fixed and tested: extractDetail NEVER throws and always
//   returns a ProductReviewData (empty partial when nothing is found).
//
// When the fixture arrives, a human fills the SELECTOR TBD constants and
// narrows the hydration path; everything downstream (cache/proxy/UI) is already
// wired against this contract.

import type { ProductReviewData, ReviewText } from '../detail/types';

// ---------------------------------------------------------------------------
// SELECTOR TBD — fill from the captured live PDP fixture (tests/fixtures/
// ml-pdp-*.html). Left empty so the DOM fallback is inert until grounded.
// `querySelector('')` throws SyntaxError, so every consumer guards `isEmpty`.
// ---------------------------------------------------------------------------
const REVIEW_CONTAINER_SELECTOR = ''; // TODO(Batch 0): reviews wrapper, e.g. '.ui-pdp-reviews'
const REVIEW_ITEM_SELECTOR = ''; // TODO(Batch 0): one review, e.g. '.ui-pdp-review'
const REVIEW_TEXT_SELECTOR = ''; // TODO(Batch 0): review body text
const REVIEW_RATING_SELECTOR = ''; // TODO(Batch 0): star rating value
const REVIEW_DATE_SELECTOR = ''; // TODO(Batch 0): review date
const PRODUCT_TITLE_SELECTOR = ''; // TODO(Batch 0): PDP <h1> title
const MORE_REVIEWS_HINT_SELECTOR = ''; // TODO(Batch 0): "Ver más" control

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
        // Hint detection is selector-gated; with selectors TBD it stays false.
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
  return items.map((item) => ({
    rating: parseRatingFromEl(item),
    text: textOf(safeQuery<HTMLElement>(item, REVIEW_TEXT_SELECTOR)),
    ...(pickDate(item) ? { date: pickDate(item)! } : {}),
  }));
}

function parseRatingFromEl(item: Element): number | null {
  const el = safeQuery<HTMLElement>(item, REVIEW_RATING_SELECTOR);
  if (!el?.textContent) return null;
  const n = parseFloat(el.textContent.replace(',', '.'));
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
 * Detect a "Ver más" / load-more reviews control. TODO: wire to the fixture's
 * real control selector. With MORE_REVIEWS_HINT_SELECTOR TBD this is a text
 * heuristic that returns false unless a clearly-labelled control is present.
 */
function detectMoreHint(doc: Document): boolean {
  if (hasSelector(MORE_REVIEWS_HINT_SELECTOR)) {
    return safeQuery<HTMLElement>(doc, MORE_REVIEWS_HINT_SELECTOR) !== null;
  }
  // Provisional text heuristic — confirm/replace against the fixture.
  try {
    const candidates = Array.from(doc.querySelectorAll('button, a'));
    return candidates.some((el) => /ver\s+m[aá]s\s+opin/i.test(el.textContent ?? ''));
  } catch {
    return false;
  }
}
