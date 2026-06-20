// ML Re-rank content script entry (Pilar 1).
//
// Runs at document_idle on every matched MercadoLibre page. Narrows to
// listing/search routes via isListingRoute(), finds the results container, and
// wires the reorderer + toggle. Makes ZERO network calls: it only reads and
// reorders the page DOM it is injected into (no fetch, no XHR, no detail-page
// hops). Selectors live ONLY in src/adapter/mercadolibre.ts.

import { findContainer } from './adapter/mercadolibre';
import { createReorderer } from './observe';
import { mountToggle } from './ui/toggle';

/**
 * Narrow the broad content-script `matches` to actual MercadoLibre
 * search/listing routes. ML search results are served from the `listado.*`
 * host family, so the broad per-TLD match patterns are gated here.
 */
function isListingRoute(): boolean {
  return location.hostname.startsWith('listado.');
}

/**
 * Wire re-ranking into the page: find the results container, create the
 * reorderer, and mount the toggle (which gates re-ranking on/off and owns the
 * observer lifecycle). No-op when not on a listing route or when no results
 * container is present, so the extension loads harmlessly on every match.
 */
export function main(): void {
  if (!isListingRoute()) return;
  const container = findContainer(document);
  if (!container) return;
  const reorderer = createReorderer(container);
  mountToggle(container, reorderer);
}

main();
