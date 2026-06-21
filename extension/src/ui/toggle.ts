// Toggle UI — injects a fixed, clearly-visible CIRCULAR power button that gates
// the reorderer. ON applies the ranked order (delegates to the reorderer, which
// sets `style.order` on the cards) and starts the observer; OFF stops the
// observer and restores the EXACT original order by CLEARING `style.order` on
// every card row (spec: "Visible Toggle and Exact Restore").
//
// Visual: circular ~56px button with a power-glyph SVG. OFF = dark glass.
// ON = ML-yellow → electric-violet gradient with a pulsating halo and conic
// rotating ring that signals an active third-party layer over the page.
// A side tooltip appears on hover; the textual state is also exposed via
// aria-pressed / data-ml-rerank-state for tests and a11y.

import type { RerankController } from '../observe';
import { powerIcon } from './icons';

const RERANK_ATTR = 'data-ml-reranked';
const STORAGE_KEY = 'ml-rerank:enabled';

function readPersistedState(): 'on' | 'off' {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

function writePersistedState(next: 'on' | 'off'): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage unavailable (opaque origin / privacy mode / quota) — degrade
    // gracefully to in-memory state; the toggle still works for this page view.
  }
}

export interface ToggleController {
  on(): void;
  off(): void;
  destroy(): void;
  isOn(): boolean;
}

export function mountToggle(
  container: HTMLElement,
  reorderer: RerankController,
): ToggleController {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ml-rerank-toggle';
  pill.setAttribute('data-ml-rerank-state', 'off');
  pill.setAttribute('aria-pressed', 'false');
  pill.setAttribute('aria-label', 'Activar re-ranking');

  // Rotating conic ring — purely decorative; visible only in the ON state via CSS.
  const ring = document.createElement('span');
  ring.className = 'ml-rerank-toggle__ring';
  ring.setAttribute('aria-hidden', 'true');

  // Pulsating halo — sits behind the button to signal "active third-party layer".
  const halo = document.createElement('span');
  halo.className = 'ml-rerank-toggle__halo';
  halo.setAttribute('aria-hidden', 'true');

  const icon = document.createElement('span');
  icon.className = 'ml-rerank-toggle__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = powerIcon;

  const tooltip = document.createElement('span');
  tooltip.className = 'ml-rerank-toggle__tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = 'Re-rank: OFF';

  pill.append(halo, ring, icon, tooltip);
  document.body.appendChild(pill);

  let state: 'on' | 'off' = 'off';

  function render(): void {
    pill.setAttribute('data-ml-rerank-state', state);
    pill.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
    pill.setAttribute('aria-label', state === 'on' ? 'Desactivar re-ranking' : 'Activar re-ranking');
    tooltip.textContent = `Re-rank: ${state.toUpperCase()}`;
  }

  function restoreOriginal(): void {
    for (const node of Array.from(container.children) as HTMLElement[]) {
      if (node.style.order !== '') node.style.order = '';
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
    // Micro press animation (re-trigger by removing the class on the next frame).
    pill.classList.remove('ml-rerank-toggle--press');
    void pill.offsetWidth;
    pill.classList.add('ml-rerank-toggle--press');
  }

  function off(): void {
    if (state === 'off') return;
    state = 'off';
    reorderer.stop();
    restoreOriginal();
    writePersistedState('off');
    render();
    pill.classList.remove('ml-rerank-toggle--press');
    void pill.offsetWidth;
    pill.classList.add('ml-rerank-toggle--press');
  }

  function toggle(): void {
    if (state === 'on') off();
    else on();
  }

  function destroy(): void {
    reorderer.stop();
    restoreOriginal();
    state = 'off';
    pill.remove();
  }

  pill.addEventListener('click', toggle);

  if (readPersistedState() === 'on') {
    on();
  } else {
    render();
  }

  return { on, off, destroy, isOn: () => state === 'on' };
}
