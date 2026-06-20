// ML Re-rank content script entry (Pilar 1 + Pilar 2 router).
//
// Runs at document_idle on every matched MercadoLibre page. It is a small
// ROUTER: listing/search pages (`listado.*`) keep Pilar 1 re-ranking UNCHANGED;
// product-detail pages (`articulo.*` or the `/p/` short route) run the Pilar 2
// review-summary pipeline; every other page is a no-op. The broad per-TLD
// `matches` are narrowed here because match patterns cannot express ML's routes.
//
// Pilar 1 makes ZERO network calls (it only reorders page DOM). Pilar 2 makes
// ONE network call to the Vercel proxy (review text only; the Gemini key is
// server-side). Selectors live ONLY in src/adapter/*.ts.

import { findContainer } from './adapter/mercadolibre';
import { createReorderer } from './observe';
import { mountToggle } from './ui/toggle';
import { runDetailSummary } from './detail';

/**
 * Narrow the broad content-script `matches` to actual MercadoLibre
 * search/listing routes. ML search results are served from the `listado.*`
 * host family. Accepts an optional `url` so the router predicate is unit-
 * testable without manipulating the global location.
 */
export function isListingRoute(url: string = location.href): boolean {
  try {
    return new URL(url).hostname.startsWith('listado.');
  } catch {
    return false;
  }
}

/**
 * Detect MercadoLibre product-detail pages (PDPs): served from the `articulo.*`
 * host family, or via the catalog `/p/<id>` (and `/up/<id>`) route on any ML
 * host. Real catalog PDPs are `www.mercadolibre.<tld>/<slug>/p/<id>`, so the
 * `/p/` (or `/up/`) segment is NOT at the start of the path — we match it
 * anywhere in the path, but only when followed by an ML id (`M` + 1-3 letters +
 * digits) to avoid false positives. Accepts an optional `url` for unit testing.
 * Returns false for listings and all other pages.
 */
export function isDetailPageRoute(url: string = location.href): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith('articulo.')) return true;
    return /\/(?:p|up)\/M[A-Z]{1,3}\d+/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Route the page: listing -> Pilar 1 reorder + toggle; PDP -> Pilar 2 summary;
 * anything else -> no-op. No-op when a listing has no results container, so the
 * extension loads harmlessly on every match.
 */
export function main(): void {
  if (isListingRoute()) {
    const container = findContainer(document);
    if (!container) return;
    const reorderer = createReorderer(container);
    mountToggle(container, reorderer);
    return;
  }
  if (isDetailPageRoute()) {
    runDetailSummary();
    return;
  }
}

main();
