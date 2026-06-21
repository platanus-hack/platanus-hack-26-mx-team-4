// Reorderer + debounced MutationObserver — reorders the results list by setting
// the CSS `order` property on each card row (NOT by moving DOM nodes).
//
// WHY CSS order (and not appendChild): MercadoLibre's listing is a React app. If
// we physically re-append the <li> rows, React's reconciler puts them back in
// its own order on the next render, so the re-rank visibly "snaps back". Setting
// `style.order` on the existing grid items reorders them VISUALLY without
// touching the DOM structure React owns, so React leaves it alone. The container
// (`ol.ui-search-layout--grid`) is a CSS grid, whose items honor `order`.
//
// Pipeline: adapter.parseCards -> ranking.rank -> assign `style.order` to each
// card row by its ranked position. Non-card rows (ads / separators) are pushed
// to the end. Restoring the original order is just clearing `style.order` (the
// DOM was never reordered), which the toggle does on OFF.
//
// Loop avoidance is now structural: our writes only set inline styles/attributes,
// never add or remove children, so the childList MutationObserver never sees its
// own work. The observer reacts ONLY to external card additions (e.g. "Ver mas",
// pagination, or a React re-render that swaps in fresh nodes), re-applying order
// to whatever is currently in the container (debounced ~250ms).

import { parseCards } from './adapter/mercadolibre';
import { rank } from './ranking/score';
import type { RankConfig } from './ranking/types';
import { RANK_CONFIG } from './config';
import { normalizePrefs } from './prefs/rankingPrefs';

/** Attribute stamped on every card row once it has been ordered by the reorderer. */
const RERANK_ATTR = 'data-ml-reranked';
/** MutationObserver debounce window (ms). */
const DEBOUNCE_MS = 250;

export interface RerankController {
  /** Parse -> rank -> assign `style.order` once. Idempotent: writes nothing when
   *  every card already carries its target order. Never moves DOM nodes. */
  reorder(): void;
  /** Begin watching the container childList; re-applies order (debounced) on
   *  external card additions (e.g. "Ver mas" / React re-render). */
  start(): void;
  /** Stop watching. Safe to call when already stopped. */
  stop(): void;
  /** Stop watching and mark the controller as destroyed (further calls no-op). */
  destroy(): void;
  /**
   * Replace the active ranking config and re-apply order to the CURRENT DOM with
   * it, reusing the parse -> rank -> order pipeline. ZERO network calls (Pilar 1
   * invariant). Does NOT start or stop the observer — the toggle owns the observe
   * lifecycle. `next` is normalized (missing/invalid fields merged from defaults,
   * negatives clamped to 0) before use.
   */
  updateConfig(next: RankConfig): void;
}

/**
 * Create a reorderer bound to `container`. Observation is NOT started; call
 * `start()` (or let the toggle do it) to react to live DOM changes.
 *
 * `initialConfig` (default `RANK_CONFIG`) sets the active weights for the first
 * `reorder()`; `updateConfig(next)` swaps them later and re-applies order.
 */
export function createReorderer(
  container: HTMLElement,
  initialConfig: RankConfig = RANK_CONFIG,
): RerankController {
  let observer: MutationObserver | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  // Normalize once on construction so a partial/invalid initial config is just
  // as safe as a later updateConfig. RANK_CONFIG normalizes to itself, so the
  // default path is unchanged (backward compatible with existing importers).
  let currentConfig: RankConfig = normalizePrefs(initialConfig);

  function reorder(): void {
    if (destroyed) return;

    const cards = parseCards(container);
    if (cards.length === 0) return;

    // `cards` is in current DOM order; `ranked` is the same nodes by descending
    // quality. Map each ranked card node to its target order index.
    const ranked = rank(cards, currentConfig);
    const orderByNode = new Map<HTMLElement, number>();
    ranked.forEach((c, i) => orderByNode.set(c.nodeRef as HTMLElement, i));

    // Assign `style.order` to every direct child: ranked cards get their rank
    // index; non-card rows (ads/separators parseCards skipped) are pushed after
    // the ranked cards in their original relative order. We only WRITE when the
    // value actually changes, so a second run with the same ranking is a no-op
    // (idempotent) and never thrashes layout.
    const nonCardBase = ranked.length;
    let nonCardOffset = 0;
    for (const child of Array.from(container.children) as HTMLElement[]) {
      const target = orderByNode.has(child) ? orderByNode.get(child)! : nonCardBase + nonCardOffset++;
      const targetStr = String(target);
      if (child.style.order !== targetStr) child.style.order = targetStr;
      if (child.getAttribute(RERANK_ATTR) !== '1') child.setAttribute(RERANK_ATTR, '1');
    }
  }

  function scheduleReorder(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reorder();
    }, DEBOUNCE_MS);
  }

  // React ONLY to external card additions. Our own work sets inline styles /
  // attributes and never adds or removes children, so it can never trigger this
  // childList observer — no guard flag or tag-skip needed. A "Ver mas" load or a
  // React re-render swaps in fresh element nodes, which is what re-triggers.
  const callback: MutationCallback = (records) => {
    if (destroyed) return;
    const addedElement = records.some((record) =>
      Array.from(record.addedNodes).some((node) => node.nodeType === 1),
    );
    if (!addedElement) return;
    scheduleReorder();
  };

  function start(): void {
    if (destroyed || observer) return;
    observer = new MutationObserver(callback);
    // childList only (no subtree): we react to card rows being added/removed at
    // the container level, not to noise inside individual cards.
    observer.observe(container, { childList: true });
  }

  function stop(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function destroy(): void {
    stop();
    destroyed = true;
  }

  function updateConfig(next: RankConfig): void {
    if (destroyed) return;
    currentConfig = normalizePrefs(next);
    reorder();
  }

  return { reorder, start, stop, destroy, updateConfig };
}

/**
 * Convenience: create a reorderer bound to `container` and immediately start
 * observing. Returns the controller so the caller can `stop()`/`destroy()`.
 * The content script uses `createReorderer` instead (the toggle owns the
 * observe lifecycle), but this is kept as the obvious top-level entry point.
 */
export function startReranking(container: HTMLElement): RerankController {
  const controller = createReorderer(container);
  controller.start();
  return controller;
}
