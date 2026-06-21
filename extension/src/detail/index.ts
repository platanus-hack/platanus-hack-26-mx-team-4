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
import { UI_SOURCES, DEFAULT_SOURCE, isExternalSource, getUiSource } from './sources/registry';
import type { ProductReviewData, ProxyRequest, SourceId } from './types';

/**
 * Cache fingerprint for an EXTERNAL source. The extension has no review set to
 * fingerprint (the proxy fetches the source), so external summaries are cached
 * per source + product with a constant fingerprint. Bump this value when the
 * external summarization contract changes so stale RTINGS summaries are not
 * reused for 7 days. (ml-internal keeps fingerprinting its extracted reviews.)
 */
const EXTERNAL_FINGERPRINT = 'ext:v2';

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
  /** Initial analysis source (default DEFAULT_SOURCE = ml-internal). */
  source?: SourceId;
}

export interface DetailSummaryController {
  /** Stop observing, remove the card, clear timers. */
  destroy(): void;
  /** Switch the active source and re-run the pipeline for it (live toggle). */
  setSource(source: SourceId): void;
  /** The currently selected source. */
  readonly currentSource: SourceId;
}

/** Drop the UI-only hint flag and form the ml-internal ProxyRequest. */
export function toProxyRequest(data: ProductReviewData): ProxyRequest {
  const req: ProxyRequest = {
    source: 'ml-internal',
    productId: data.productId,
    productTitle: data.productTitle,
    reviews: data.reviews,
  };
  if (data.locale) req.locale = data.locale;
  return req;
}

/**
 * Form an EXTERNAL-source ProxyRequest (e.g. RTINGS). Carries a productQuery
 * (title-derived) instead of reviews; the proxy does the source lookup. The
 * conservative matcher tokenizes the title, so passing the title is sufficient.
 */
export function toExternalRequest(data: ProductReviewData, source: SourceId): ProxyRequest {
  const req: ProxyRequest = {
    source,
    productId: data.productId,
    productTitle: data.productTitle,
    productQuery: { title: data.productTitle },
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

  let currentSource: SourceId = opts.source ?? DEFAULT_SOURCE;

  const view: SummaryView = createSummaryView(host, {
    sources: UI_SOURCES,
    currentSource,
    onSourceChange: (next) => setSource(next),
  });
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

    // External source (e.g. RTINGS): no PDP review extraction / observer. Derive
    // the product identity, check the per-source cache, then ask the proxy to
    // fetch + summarize the source. A no-match renders the fallback state.
    if (isExternalSource(currentSource)) {
      attemptExternal();
      return;
    }

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
    const cached = readCache(request.productId, fingerprint, currentSource);
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

  /**
   * External-source attempt (e.g. RTINGS). Derives the product identity from the
   * PDP, checks the per-source cache, then asks the proxy to fetch + summarize
   * the source. There is NO MutationObserver here (the data is server-side, not
   * in the ML DOM). A 'no-source-data' result renders the fallback (with a
   * one-click switch back to ml-internal) and finishes.
   */
  function attemptExternal(): void {
    const data = extractDetail(doc, url);
    const request = toExternalRequest(data, currentSource);

    const cached = readCache(request.productId, EXTERNAL_FINGERPRINT, currentSource);
    if (cached) {
      view.showResult(cached.data);
      finish();
      return;
    }

    view.showLoading();
    inFlight = true;
    void fetchAndRender(request, EXTERNAL_FINGERPRINT);
  }

  async function fetchAndRender(request: ProxyRequest, fingerprint: string): Promise<void> {
    // Pin the source this fetch was started for, so a result that resolves AFTER
    // the user switched sources is ignored (no stale render into the new source).
    const fetchSource = currentSource;
    // fetchSummary never throws (returns a typed error), so no try/catch needed.
    const result = await fetchSummary(request, fetchImpl);
    // Clear inFlight BEFORE any re-dispatch so a follow-up attempt() can proceed.
    inFlight = false;
    if (destroyed) return;

    if (fetchSource !== currentSource) {
      // The user switched sources while this fetch was in flight: discard this
      // (now stale) result and re-run the pipeline for the current source.
      attempt();
      if (!rendered && !destroyed && !isExternalSource(currentSource)) startObserver();
      return;
    }

    if (result.ok) {
      writeCache(request.productId, fingerprint, result.data, fetchSource);
      view.showResult(result.data);
      finish();
    } else if (result.error.kind === 'no-source-data') {
      // External source has no analysis for this product: render the honest
      // fallback with a one-click return to ML opinions. Not an error/retry.
      stopObserver();
      view.showNoSourceData({
        label: getUiSource(fetchSource)?.label ?? String(fetchSource),
        onSwitchToInternal: () => setSource(DEFAULT_SOURCE),
      });
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

  /**
   * Switch the active source and re-run the pipeline for it (live toggle). Resets
   * the per-attempt state (so a previously-finished source can render again),
   * reflects the selection in the card header, shows the skeleton, and re-runs.
   * For ml-internal it re-arms the lazy-review observer; external sources don't
   * use it. A no-op when the source is unchanged or the card is destroyed.
   */
  function setSource(next: SourceId): void {
    if (destroyed || next === currentSource) return;
    if (!getUiSource(next)) return; // ignore unknown sources
    currentSource = next;
    // Reset state so attempt() runs fresh for the new source. inFlight is left
    // as-is: any in-flight fetch for the OLD source is ignored on resolve via
    // the fetchSource pin, and its `finally` clears inFlight.
    rendered = false;
    stopObserver();
    emptyAttempts = 0;
    totalEmptyAttempts = 0;
    emptyStartedAt = 0;
    view.setActiveSource(currentSource);
    view.showLoading();
    attempt();
    if (!rendered && !destroyed && !isExternalSource(currentSource)) startObserver();
  }

  // Initial synchronous attempt (extract + cache hit / empty render, or kick off
  // the async fetch). Its card mutations happen BEFORE the observer starts, so
  // they cannot self-trigger.
  attempt();
  if (!rendered && !destroyed && !isExternalSource(currentSource)) startObserver();

  return {
    destroy,
    setSource,
    get currentSource() {
      return currentSource;
    },
  };
}
