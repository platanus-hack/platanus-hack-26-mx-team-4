// Detail-pipeline orchestrator (Pilar 2) — wires adapter -> cache -> proxy ->
// render, with a debounced MutationObserver that re-runs extraction for
// lazily-loaded reviews until the first successful render. It NEVER auto-clicks
// "Ver más" (per design); it only observes and re-extracts.
//
// Flow:
//   render skeleton -> extractDetail -> (no reviews? empty + observe for lazy)
//   -> (reviews? cache hit? render) -> (cache miss? proxy -> parse -> cache
//   write -> render). On error: render retry state and stop observing (the
//   retry button re-attempts; a proxy/parse error is not fixed by more reviews).
//
// Loop avoidance: the card root is tagged data-ml-summary, and the observer
// ignores any mutation whose target/added nodes are inside the card, so our own
// renders never re-trigger us. A 250ms debounce coalesces bursts (same window
// as Pilar 1).

import { extractDetail } from '../adapter/ml-detail';
import { readCache, writeCache } from './cache';
import { fetchSummary } from './proxyClient';
import { createSummaryView, type SummaryView } from './summaryUI';
import type { ProductReviewData, ProxyRequest } from './types';

/** MutationObserver debounce window (ms) — matches Pilar 1. */
const DEBOUNCE_MS = 250;

/** Options for testability: every dependency can be injected. */
export interface RunDetailOptions {
  doc?: Document;
  url?: string;
  /** Where to mount the summary card. Defaults to document.body. */
  mountHost?: HTMLElement;
  /** Root to observe for lazy reviews. Defaults to document.body.
   *  TODO(Batch 0): narrow to the fixture's review container once selectors
   *  are known, to reduce observation noise. */
  observeRoot?: Node;
  /** Injectable fetch (tests mock the proxy). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DetailSummaryController {
  /** Stop observing, remove the card, clear timers. */
  destroy(): void;
}

/** Drop the UI-only hint flag and form the public ProxyRequest. */
export function toProxyRequest(data: ProductReviewData): ProxyRequest {
  const req: ProxyRequest = {
    productId: data.productId,
    productTitle: data.productTitle,
    reviews: data.reviews,
  };
  if (data.locale) req.locale = data.locale;
  return req;
}

/**
 * Run the PDP summary pipeline. Renders into `mountHost`, observes
 * `observeRoot` for lazy reviews, and stops after the first successful render
 * (or on error). Returns a controller for cleanup / tests.
 */
export function runDetailSummary(opts: RunDetailOptions = {}): DetailSummaryController {
  const doc = opts.doc ?? document;
  const url = opts.url ?? (typeof location !== 'undefined' ? location.href : '');
  const host = opts.mountHost ?? document.body;
  const observeRoot = opts.observeRoot ?? document.body;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const view: SummaryView = createSummaryView(host);
  view.showLoading();

  let rendered = false; // a successful result has been rendered
  let inFlight = false; // a proxy fetch is in progress (guard against re-entry)
  let destroyed = false;
  let observer: MutationObserver | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  function isWithinCard(node: Node): boolean {
    if (node === view.el) return true;
    if (view.el.contains(node)) return true;
    // Text nodes: a write inside the card has its parent inside the card.
    const parent = node.parentNode;
    return parent != null && view.el.contains(parent);
  }

  function attempt(): void {
    if (rendered || destroyed || inFlight) return;

    const data = extractDetail(doc, url);
    if (data.reviews.length === 0) {
      // Empty PDP (or lazy reviews not yet loaded). Render the empty state and
      // keep observing so lazily-loaded reviews trigger a re-attempt.
      view.showEmpty({ hasMoreReviewsHint: data.hasMoreReviewsHint });
      return;
    }

    const request = toProxyRequest(data);

    // Cache hit -> render immediately, no proxy call (spec: "Cache hits MUST
    // avoid proxy calls").
    const cached = readCache(request.productId);
    if (cached) {
      view.showResult(cached.data);
      finish();
      return;
    }

    // Cache miss -> fetch. Show the skeleton while the proxy works.
    view.showLoading();
    inFlight = true;
    void fetchAndRender(request);
  }

  async function fetchAndRender(request: ProxyRequest): Promise<void> {
    try {
      const result = await fetchSummary(request, fetchImpl);
      if (destroyed) return;
      if (result.ok) {
        writeCache(request.productId, result.data);
        view.showResult(result.data);
        finish();
      } else {
        // Stop observing on error: a proxy/parse/network error is not resolved
        // by more reviews arriving, and re-attempting on every DOM mutation
        // would hammer the proxy. The retry button re-attempts on user intent.
        stopObserver();
        view.showError(result.error, () => {
          if (rendered || destroyed) return;
          inFlight = true;
          void fetchAndRender(request);
        });
      }
    } finally {
      inFlight = false;
    }
  }

  function finish(): void {
    rendered = true;
    stopObserver();
  }

  function stopObserver(): void {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function startObserver(): void {
    if (observer || destroyed) return;
    const callback: MutationCallback = (records) => {
      if (rendered || destroyed) return;
      // Ignore mutations entirely within our own card (our renders).
      const external = records.some((record) => {
        if (isWithinCard(record.target)) return false;
        return Array.from(record.addedNodes).some((node) => !isWithinCard(node));
      });
      if (!external) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        attempt();
      }, DEBOUNCE_MS);
    };
    observer = new MutationObserver(callback);
    observer.observe(observeRoot, { childList: true, subtree: true });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    stopObserver();
    view.destroy();
  }

  // Initial synchronous attempt (extract + cache hit / empty render, or kick off
  // the async fetch). Its card mutations happen BEFORE the observer starts, so
  // they cannot self-trigger.
  attempt();
  if (!rendered && !destroyed) startObserver();

  return { destroy };
}
