// Reorderer + debounced MutationObserver — idempotent in-place re-append of
// existing card nodes inside the results container.
//
// Pipeline: adapter.parseCards -> ranking.rank -> re-append the existing card
// DOM nodes (the <li> rows) into ranked order. No cloning, no shell
// replacement: the SAME node references are moved within the SAME container, so
// MercadoLibre's own handlers, event listeners, and lazy-load state stay intact.
//
// Loop avoidance (three layers, per design section 7):
//   1. Re-entrancy guard `isReordering` set true around DOM writes — defense in
//      depth against any synchronous re-entry.
//   2. `data-ml-reranked="1"` stamped on every moved node; the observer skips
//      mutations whose added nodes are all already tagged (i.e. our own
//      re-append), so a "Ver mas" load (untagged new nodes) is what re-triggers.
//   3. ~250ms debounce coalesces bursts, and `reorder()` itself is idempotent:
//      when the DOM is already in ranked order it writes nothing, so any
//      callback that does slip through re-ranks to the same order -> no new
//      mutation -> no loop.

import { parseCards } from './adapter/mercadolibre';
import { rank } from './ranking/score';
import { RANK_CONFIG } from './config';

/** Attribute stamped on every card row once it has been moved by the reorderer. */
const RERANK_ATTR = 'data-ml-reranked';
/** MutationObserver debounce window (ms). */
const DEBOUNCE_MS = 250;

export interface RerankController {
  /** Run parse -> rank -> re-append once. Idempotent: a no-op when the DOM is
   *  already in ranked order, so it does not retrigger the observer. */
  reorder(): void;
  /** Begin watching the container childList; re-ranks (debounced) on external
   *  card additions (e.g. "Ver mas"). Our own re-appends are skipped. */
  start(): void;
  /** Stop watching. Safe to call when already stopped. */
  stop(): void;
  /** Stop watching and mark the controller as destroyed (further calls no-op). */
  destroy(): void;
}

/**
 * Create a reorderer bound to `container`. Observation is NOT started; call
 * `start()` (or let the toggle do it) to react to live DOM changes. The
 * content script creates this and hands it to the toggle, which gates
 * `start()`/`stop()` on the ON/OFF state per design section 7.
 */
export function createReorderer(container: HTMLElement): RerankController {
  let observer: MutationObserver | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isReordering = false;
  let destroyed = false;

  function reorder(): void {
    if (destroyed || isReordering) return;

    const cards = parseCards(container);
    if (cards.length === 0) return;

    // `cards` is in current DOM order (querySelectorAll is document order);
    // `ranked` is the same nodes in descending quality order.
    const ranked = rank(cards, RANK_CONFIG);
    const rankedNodes = ranked.map((c) => c.nodeRef);
    const currentNodes = cards.map((c) => c.nodeRef);

    // Idempotency: if the DOM is already in ranked order, write nothing. This
    // is what makes a second run (or an observer callback fired by our own
    // writes) a no-op, so no mutation is emitted and no loop starts.
    const alreadyRanked =
      currentNodes.length === rankedNodes.length &&
      currentNodes.every((node, i) => node === rankedNodes[i]);
    if (alreadyRanked) return;

    isReordering = true;
    try {
      // appendChild on an existing node MOVES it to the end of the container.
      // Iterating in ranked order re-appends the same nodes into ranked order,
      // in place. Tag every moved node as processed (observer skip signal).
      for (const node of rankedNodes) {
        container.appendChild(node);
        node.setAttribute(RERANK_ATTR, '1');
      }
    } finally {
      isReordering = false;
    }
  }

  function scheduleReorder(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reorder();
    }, DEBOUNCE_MS);
  }

  function isTagged(node: Node): boolean {
    return node.nodeType === 1 && (node as Element).hasAttribute(RERANK_ATTR);
  }

  // Ignore mutations that are entirely our own tagged-node re-appends; only
  // external additions (untagged new cards, e.g. "Ver mas") re-trigger.
  const callback: MutationCallback = (records) => {
    if (isReordering || destroyed) return;
    const hasExternalChange = records.some((record) =>
      Array.from(record.addedNodes).some((node) => !isTagged(node)),
    );
    if (!hasExternalChange) return;
    scheduleReorder();
  };

  function start(): void {
    if (destroyed || observer) return;
    observer = new MutationObserver(callback);
    // childList only (no subtree): we react to card rows being added/removed
    // at the container level, not to noise inside individual cards.
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

  return { reorder, start, stop, destroy };
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
