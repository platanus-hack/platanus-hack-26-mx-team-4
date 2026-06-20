// Summary card UI (Pilar 2) — renders the LLM summary into the PDP with four
// states: loading (skeleton), result (strong/weak/verdict), empty (no reviews),
// and error (retryable / rate-limited).
//
// LAYOUT: a PERSISTENT header (title + minimize/expand button) is created once
// and survives every state change; only the BODY is replaced per state. The
// minimize button toggles `data-ml-collapsed` on the card root (CSS hides the
// body when collapsed), so the user can shrink the card out of the way without
// losing the summary.
//
// SECURITY/ROBUSTNESS: every user-facing string is set via textContent, NEVER
// innerHTML. Strong/weak points come from the LLM and are treated as untrusted
// text — they are never parsed as HTML, so no markup injection is possible.
//
// Styling lives in src/content.css (.ml-summary-card). The card root is tagged
// `data-ml-summary` so the pipeline's MutationObserver can ignore our own
// writes (loop avoidance, same idea as Pilar 1's data-ml-reranked tag).

import type { ProxyResponse, SummaryError } from './types';

/** State stamped on the card root so CSS + tests can read the current state. */
export type SummaryState = 'loading' | 'empty' | 'error' | 'result';

/** A mounted summary card bound to a host element. */
export interface SummaryView {
  /** The card root element (tagged data-ml-summary). */
  readonly el: HTMLElement;
  showLoading(): void;
  showEmpty(opts?: { hasMoreReviewsHint?: boolean }): void;
  showError(error: SummaryError, onRetry?: () => void): void;
  showResult(summary: ProxyResponse): void;
  /** Remove the card from the DOM. */
  destroy(): void;
}

/** Attribute stamped on the card root for state + observer loop-avoidance. */
const SUMMARY_ATTR = 'data-ml-summary';
/** Attribute toggled by the minimize button (CSS hides the body when "true"). */
const COLLAPSED_ATTR = 'data-ml-collapsed';

/**
 * Create a summary card and append it to `host`. The card root + its header
 * (title + minimize button) are created once; only the BODY is replaced across
 * state transitions, so the minimize control persists and the pipeline observer
 * can ignore our own writes.
 */
export function createSummaryView(host: HTMLElement): SummaryView {
  const card = document.createElement('aside');
  card.className = 'ml-summary-card';
  card.setAttribute(SUMMARY_ATTR, 'loading');
  card.setAttribute(COLLAPSED_ATTR, 'false');

  // Persistent header: title + minimize/expand toggle. Survives state changes.
  const header = document.createElement('div');
  header.className = 'ml-summary-card__header';
  const title = document.createElement('div');
  title.className = 'ml-summary-card__title';
  title.textContent = 'Resumen de opiniones';
  const minimize = document.createElement('button');
  minimize.type = 'button';
  minimize.className = 'ml-summary-card__minimize';
  minimize.setAttribute('aria-expanded', 'true');
  minimize.setAttribute('aria-label', 'Minimizar resumen');
  minimize.textContent = '–';
  minimize.addEventListener('click', toggleCollapsed);
  header.append(title, minimize);

  // Body: cleared + rebuilt on every state transition.
  const body = document.createElement('div');
  body.className = 'ml-summary-card__body';

  card.append(header, body);
  host.appendChild(card);

  function toggleCollapsed(): void {
    const collapsed = card.getAttribute(COLLAPSED_ATTR) === 'true';
    const next = !collapsed;
    card.setAttribute(COLLAPSED_ATTR, String(next));
    minimize.setAttribute('aria-expanded', String(!next));
    minimize.textContent = next ? '+' : '–';
    minimize.setAttribute('aria-label', next ? 'Expandir resumen' : 'Minimizar resumen');
  }

  function clear(): void {
    while (body.firstChild) body.removeChild(body.firstChild);
  }

  function setState(state: SummaryState): void {
    card.setAttribute(SUMMARY_ATTR, state);
  }

  function showLoading(): void {
    setState('loading');
    clear();
    for (let i = 0; i < 3; i++) {
      const line = document.createElement('div');
      line.className = 'ml-summary-card__skeleton';
      body.appendChild(line);
    }
  }

  function showEmpty(opts?: { hasMoreReviewsHint?: boolean }): void {
    setState('empty');
    clear();
    const msg = document.createElement('p');
    msg.className = 'ml-summary-card__empty';
    msg.textContent = 'Aún no hay opiniones para resumir.';
    body.appendChild(msg);
    if (opts?.hasMoreReviewsHint) {
      const hint = document.createElement('p');
      hint.className = 'ml-summary-card__hint';
      hint.textContent = 'Podés expandir las opiniones en la página y recargar.';
      body.appendChild(hint);
    }
  }

  function showError(error: SummaryError, onRetry?: () => void): void {
    setState('error');
    clear();
    const msg = document.createElement('p');
    msg.className = 'ml-summary-card__error';
    msg.textContent = error.message;
    body.appendChild(msg);

    if (error.kind === 'rate-limited') {
      // 429 (rate limit / quota): retrying now won't help, so instead of a dead
      // disabled button we show a calm hint. Keeps the failed state looking
      // intentional and polished rather than broken.
      const hint = document.createElement('p');
      hint.className = 'ml-summary-card__hint';
      hint.textContent = 'Volvé a intentarlo más tarde.';
      body.appendChild(hint);
    } else if (onRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ml-summary-card__retry';
      retry.textContent = 'Reintentar';
      retry.addEventListener('click', onRetry);
      body.appendChild(retry);
    }
  }

  function showResult(summary: ProxyResponse): void {
    setState('result');
    clear();
    appendSection('Puntos a favor', 'ml-summary-card__strong', summary.strongPoints);
    appendSection('Puntos en contra', 'ml-summary-card__weak', summary.weakPoints);

    const verdictBox = document.createElement('div');
    verdictBox.className = 'ml-summary-card__verdict';
    const label = document.createElement('span');
    label.className = 'ml-summary-card__verdict-label';
    label.textContent = 'Veredicto';
    const verdict = document.createElement('p');
    verdict.textContent = summary.verdict;
    verdictBox.append(label, verdict);
    body.appendChild(verdictBox);
  }

  function appendSection(labelText: string, itemClass: string, items: string[]): void {
    const section = document.createElement('div');
    section.className = 'ml-summary-card__section';
    const label = document.createElement('div');
    label.className = 'ml-summary-card__section-label';
    label.textContent = labelText;
    section.appendChild(label);
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'ml-summary-card__section-empty';
      empty.textContent = '—';
      section.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      for (const item of items) {
        const li = document.createElement('li');
        li.className = itemClass;
        li.textContent = item; // untrusted LLM text -> textContent only
        list.appendChild(li);
      }
      section.appendChild(list);
    }
    body.appendChild(section);
  }

  function destroy(): void {
    card.remove();
  }

  return {
    el: card,
    showLoading,
    showEmpty,
    showError,
    showResult,
    destroy,
  };
}
