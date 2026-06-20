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
import { readCache, writeCache, reviewsFingerprint } from './cache';
import { fetchSummary } from './proxyClient';
import { createSummaryView, type SummaryView } from './summaryUI';
import type { ProductReviewData, ProxyRequest } from './types';

/** MutationObserver debounce window (ms) — matches Pilar 1. */
const DEBOUNCE_MS = 250;
/**
 * Empty-state observation bounds (Issue 5b). On a PDP that genuinely has no
 * reviews, the observer used to watch `document.body` (subtree:true) forever,
 * re-extracting on every mutation. We cap it two ways: a max number of empty
 * re-attempts OR a timeout window from the first empty render — whichever comes
 * first. After the cap the observer disconnects and the final empty state stays.
 * Lazy-reviews flow is preserved: reviews hydrating shortly after load still
 * trigger a successful render BEFORE the cap (the cap only stops indefinite
 * re-extraction of a permanently-empty PDP).
 */
const MAX_EMPTY_ATTEMPTS = 20;
const EMPTY_OBSERVE_TIMEOUT_MS = 10_000;
/**
 * ABSOLUTE ceiling applied to EVERY empty PDP, including one that exposes a
 * "Mostrar más opiniones" hint. The short cap above stops a truly-empty PDP
 * quickly; this hard ceiling guarantees the document.body observer can NEVER run
 * for the whole tab lifetime when reviews never arrive (the hint path included).
 */
const MAX_TOTAL_EMPTY_ATTEMPTS = 120;
const ABSOLUTE_OBSERVE_TIMEOUT_MS = 60_000;

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
  /** Max empty-state re-attempts before stopping the observer (default 20). */
  maxEmptyAttempts?: number;
  /** Empty-state observation timeout in ms (default 10000). */
  emptyObserveTimeoutMs?: number;
  /** Absolute max empty re-attempts before stopping, even WITH a more-reviews
   *  hint (default 120). */
  maxTotalEmptyAttempts?: number;
  /** Absolute observation ceiling in ms, even WITH a hint (default 60000). */
  absoluteObserveTimeoutMs?: number;
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
  const maxEmptyAttempts = opts.maxEmptyAttempts ?? MAX_EMPTY_ATTEMPTS;
  const emptyObserveTimeoutMs = opts.emptyObserveTimeoutMs ?? EMPTY_OBSERVE_TIMEOUT_MS;
  const maxTotalEmptyAttempts = opts.maxTotalEmptyAttempts ?? MAX_TOTAL_EMPTY_ATTEMPTS;
  const absoluteObserveTimeoutMs = opts.absoluteObserveTimeoutMs ?? ABSOLUTE_OBSERVE_TIMEOUT_MS;

  const view: SummaryView = createSummaryView(host);
  view.showLoading();

  let rendered = false; // a successful result has been rendered
  let inFlight = false; // a proxy fetch is in progress (guard against re-entry)
  let destroyed = false;
  let observer: MutationObserver | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  // Empty-state observation accounting (Issue 5b): count empty re-attempts and
  // remember when the first empty render happened, so we can stop observing a
  // permanently-empty PDP after the cap instead of watching document.body forever.
  let emptyAttempts = 0;
  let emptyStartedAt = 0;
  let emptyTimeout: ReturnType<typeof setTimeout> | null = null;
  // Absolute ceiling accounting: counts EVERY empty attempt (hint or not) and
  // arms a hard timeout, so the observer can never watch document.body forever.
  let totalEmptyAttempts = 0;
  let absoluteTimeout: ReturnType<typeof setTimeout> | null = null;

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
      //
      // Issue 5b / Round 2: only BOUND the observation when the PDP is TRULY
      // empty (no more-reviews hint). When `hasMoreReviewsHint === true` the
      // PDP exposes a "Mostrar más opiniones" control, so reviews can still
      // appear via user-driven expansion AFTER the cap window — applying the
      // disconnect cap there would cut off legitimate late arrivals. The cap
      // (maxEmptyAttempts OR emptyObserveTimeoutMs) only applies when there is
      // no more-reviews hint (a permanently-empty PDP). Lazy-hydration that
      // happens shortly after load still renders BEFORE the cap in both cases.
      view.showEmpty({ hasMoreReviewsHint: data.hasMoreReviewsHint });

      // ABSOLUTE ceiling (Round 3 fix): arm a hard time + attempt cap on the
      // FIRST empty render and enforce it across ALL subsequent attempts — hint
      // or not — so the document.body observer can never run for the whole tab
      // lifetime even when `hasMoreReviewsHint === true` and reviews never come.
      totalEmptyAttempts++;
      if (totalEmptyAttempts === 1) {
        absoluteTimeout = setTimeout(() => {
          absoluteTimeout = null;
          if (!rendered && !destroyed && observer) stopObserver();
        }, absoluteObserveTimeoutMs);
      }
      if (totalEmptyAttempts >= maxTotalEmptyAttempts) {
        stopObserver();
        return;
      }

      if (data.hasMoreReviewsHint) {
        // The PDP exposes a "Mostrar más opiniones" control, so reviews can
        // still arrive via user-driven expansion AFTER the short window. Do NOT
        // apply the SHORT cap here — and CLEAR any short timer armed by an
        // earlier no-hint attempt, so a stale short timeout can't disconnect the
        // still-useful observer. The absolute ceiling above still bounds it.
        if (emptyTimeout) {
          clearTimeout(emptyTimeout);
          emptyTimeout = null;
        }
        return;
      }

      // No more-reviews hint: a truly-empty PDP. Apply the SHORT cap so we stop
      // re-extracting quickly (whichever of attempts / timeout comes first).
      emptyAttempts++;
      if (emptyAttempts === 1) {
        emptyStartedAt = Date.now();
        emptyTimeout = setTimeout(() => {
          emptyTimeout = null;
          if (!rendered && !destroyed && observer) stopObserver();
        }, emptyObserveTimeoutMs);
      }
      if (emptyAttempts >= maxEmptyAttempts || Date.now() - emptyStartedAt >= emptyObserveTimeoutMs) {
        stopObserver();
      }
      return;
    }

    const request = toProxyRequest(data);

    // Cache identity is keyed by productId + a fingerprint of the extracted
    // review set, so a changed review set (more reviews expanded on the PDP)
    // MISSES the old entry instead of serving a stale summary for up to 7 days.
    const fingerprint = reviewsFingerprint(data.reviews);
    // Cache hit -> render immediately, no proxy call (spec: "Cache hits MUST
    // avoid proxy calls").
    const cached = readCache(request.productId, fingerprint);
    if (cached) {
      view.showResult(cached.data);
      finish();
      return;
    }

    // Cache miss -> fetch. Show the skeleton while the proxy works.
    view.showLoading();
    inFlight = true;
    void fetchAndRender(request, fingerprint);
  }

  async function fetchAndRender(request: ProxyRequest, fingerprint: string): Promise<void> {
    try {
      const result = await fetchSummary(request, fetchImpl);
      if (destroyed) return;
      if (result.ok) {
        writeCache(request.productId, fingerprint, result.data);
        view.showResult(result.data);
        finish();
      } else {
        // Stop observing on error: a proxy/parse/network error is not resolved
        // by more reviews arriving, and re-attempting on every DOM mutation
        // would hammer the proxy. The retry button re-attempts on user intent.
        stopObserver();
        view.showError(result.error, () => {
          // Issue 4: a double-click on "Reintentar" must NOT start a second
          // concurrent fetch. The `inFlight` guard (in addition to the existing
          // rendered/destroyed checks) prevents the re-entry.
          if (rendered || destroyed || inFlight) return;
          inFlight = true;
          void fetchAndRender(request, fingerprint);
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
    if (emptyTimeout) {
      clearTimeout(emptyTimeout);
      emptyTimeout = null;
    }
    if (absoluteTimeout) {
      clearTimeout(absoluteTimeout);
      absoluteTimeout = null;
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
