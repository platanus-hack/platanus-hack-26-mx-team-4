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

/** Per-container snapshot of the original (pre-rerank) direct-children order. */
const originalOrder = new WeakMap<HTMLElement, HTMLElement[]>();

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
    render();
  }

  function off(): void {
    if (state === 'off') return;
    state = 'off';
    reorderer.stop();
    restoreOriginal();
    render();
  }

  function toggle(): void {
    if (state === 'on') off();
    else on();
  }

  function destroy(): void {
    off();
    pill.remove();
    originalOrder.delete(container);
  }

  pill.addEventListener('click', toggle);
  render();

  return { on, off, destroy, isOn: () => state === 'on' };
}
