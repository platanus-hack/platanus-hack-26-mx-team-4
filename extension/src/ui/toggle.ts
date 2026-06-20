// Toggle UI — injects a fixed, clearly-visible pill control that gates the
// reorderer. The original card order is snapshotted at mount time (before any
// re-ranking), stored per-container in a WeakMap. ON applies the ranked order
// (delegates to the reorderer) and starts the observer; OFF stops the observer
// and restores the EXACT snapshotted original order, including ties and
// sponsored cards (spec: "Visible Toggle and Exact Restore").
//
// Styling lives in src/content.css (.ml-rerank-toggle). The pill is appended to
// document.body with position:fixed and max z-index so it floats over ML's UI.

import type { RerankController } from '../observe';

/** Attribute stamped on reordered card rows by the reorderer; cleared on restore. */
const RERANK_ATTR = 'data-ml-reranked';

/**
 * localStorage key for the persisted toggle state (`"on"` / `"off"`). Uses the
 * PAGE's localStorage (content scripts share the page's origin storage), NOT
 * chrome.storage, so the manifest stays permission-free. All MercadoLibre
 * listing pages within one TLD share an origin, so the state survives the
 * full-page navigations ML uses for pagination (`..._Desde_N`).
 */
const STORAGE_KEY = 'ml-rerank:enabled';

/** Per-container snapshot of the original (pre-rerank) direct-children order. */
const originalOrder = new WeakMap<HTMLElement, HTMLElement[]>();

/**
 * Read the persisted toggle state. Returns `'off'` for any missing/unknown
 * value, and ALSO on any storage access failure (opaque origin, privacy mode,
 * quota/disabled storage). A storage failure must NEVER break the toggle — it
 * just falls back to the in-memory `'off'` default (per jsdom opaque-origin
 * discovery: `localStorage` access can throw on non-real-origin windows).
 */
function readPersistedState(): 'on' | 'off' {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/**
 * Persist the toggle state. Silently ignores any storage failure so toggling
 * keeps working for the current page view even when storage is unavailable.
 */
function writePersistedState(next: 'on' | 'off'): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage unavailable (opaque origin / privacy mode / quota) — degrade
    // gracefully to in-memory state; the toggle still works for this page view.
  }
}

export interface ToggleController {
  /** Apply ranked order and start observing. No-op if already on. */
  on(): void;
  /** Stop observing and restore the exact original order. No-op if already off. */
  off(): void;
  /** Remove the pill, stop the reorderer, and restore the original order. */
  destroy(): void;
  /** Current state. */
  isOn(): boolean;
}

/**
 * Inject the re-rank toggle pill and wire it to `reorderer` operating on
 * `container`. The original order is snapshotted once, at mount, so OFF always
 * restores exactly what MercadoLibre served — regardless of any intermediate
 * ML reorders. Returns a controller for programmatic use (and tests).
 */
export function mountToggle(
  container: HTMLElement,
  reorderer: RerankController,
): ToggleController {
  // Snapshot the exact original order BEFORE any re-ranking. Captured once, at
  // mount, so OFF always restores what MercadoLibre originally served.
  if (!originalOrder.has(container)) {
    originalOrder.set(container, Array.from(container.children) as HTMLElement[]);
  }

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ml-rerank-toggle';
  pill.setAttribute('data-ml-rerank-state', 'off');
  pill.setAttribute('aria-pressed', 'false');
  pill.title = 'Toggle MercadoLibre quality re-ranking';

  const dot = document.createElement('span');
  dot.className = 'ml-rerank-toggle__dot';
  const text = document.createElement('span');
  text.className = 'ml-rerank-toggle__text';
  text.textContent = 'Re-rank: OFF';
  pill.append(dot, text);
  document.body.appendChild(pill);

  let state: 'on' | 'off' = 'off';

  function render(): void {
    pill.setAttribute('data-ml-rerank-state', state);
    pill.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
    text.textContent = `Re-rank: ${state.toUpperCase()}`;
  }

  /** Re-append the snapshotted nodes in original order (in place, no clone). */
  function restoreOriginal(): void {
    const snapshot = originalOrder.get(container);
    if (!snapshot) return;
    for (const node of snapshot) {
      container.appendChild(node);
      if (node.hasAttribute(RERANK_ATTR)) node.removeAttribute(RERANK_ATTR);
    }
  }

  function on(): void {
    if (state === 'on') return;
    state = 'on';
    reorderer.reorder();
    reorderer.start();
    writePersistedState('on');
    render();
  }

  function off(): void {
    if (state === 'off') return;
    state = 'off';
    reorderer.stop();
    restoreOriginal();
    writePersistedState('off');
    render();
  }

  function toggle(): void {
    if (state === 'on') off();
    else on();
  }

  function destroy(): void {
    // Teardown is NOT a user toggle action, so do NOT persist 'off' here —
    // writing 'off' would silently clear the cross-page persistence a user left
    // enabled. Restore the original order, stop the observer, drop the snapshot,
    // and remove the pill. (In production the pill lives for the whole page
    // session; this is mainly used by tests / explicit cleanup.)
    reorderer.stop();
    restoreOriginal();
    state = 'off';
    pill.remove();
    originalOrder.delete(container);
  }

  pill.addEventListener('click', toggle);

  // Pagination persistence: ML listing pagination (page 1 -> page 2) is a FULL
  // page navigation to `..._Desde_N`, so the content script re-injects fresh on
  // every page. Without persistence the toggle would reset to OFF on each page
  // and the user would have to re-enable re-ranking every time. So, if the
  // persisted state is "on" (written by a previous page in the same origin),
  // auto-apply ON here: reorder + start the observer + render the pill as ON.
  //
  // The original-order snapshot above was captured BEFORE this auto-apply, so
  // OFF still restores ML's true original order on THIS page. A storage failure
  // (opaque origin / privacy mode) degrades to the OFF default — never throws.
  if (readPersistedState() === 'on') {
    on();
  } else {
    render();
  }

  return { on, off, destroy, isOn: () => state === 'on' };
}
