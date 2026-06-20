// Summary card UI (Pilar 2) — renders the LLM summary into the PDP with four
// states: loading (skeleton), result (strong/weak/verdict), empty (no reviews),
// and error (retryable / rate-limited).
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

/**
 * Create a summary card and append it to `host`. The card root is created once
 * and reused across state transitions (each show* replaces only its children),
 * so we do not churn the host and the pipeline observer can ignore us.
 */
export function createSummaryView(host: HTMLElement): SummaryView {
  const card = document.createElement('aside');
  card.className = 'ml-summary-card';
  card.setAttribute(SUMMARY_ATTR, 'loading');
  host.appendChild(card);

  function clear(): void {
    while (card.firstChild) card.removeChild(card.firstChild);
  }

  function setState(state: SummaryState): void {
    card.setAttribute(SUMMARY_ATTR, state);
  }

  function showLoading(): void {
    setState('loading');
    clear();
    const head = document.createElement('div');
    head.className = 'ml-summary-card__title';
    head.textContent = 'Resumen de opiniones';
    card.appendChild(head);
    for (let i = 0; i < 3; i++) {
      const line = document.createElement('div');
      line.className = 'ml-summary-card__skeleton';
      card.appendChild(line);
    }
  }

  function showEmpty(opts?: { hasMoreReviewsHint?: boolean }): void {
    setState('empty');
    clear();
    const msg = document.createElement('p');
    msg.className = 'ml-summary-card__empty';
    msg.textContent = 'Aún no hay opiniones para resumir.';
    card.appendChild(msg);
    if (opts?.hasMoreReviewsHint) {
      const hint = document.createElement('p');
      hint.className = 'ml-summary-card__hint';
      hint.textContent = 'Podés expandir las opiniones en la página y recargar.';
      card.appendChild(hint);
    }
  }

  function showError(error: SummaryError, onRetry?: () => void): void {
    setState('error');
    clear();
    const msg = document.createElement('p');
    msg.className = 'ml-summary-card__error';
    msg.textContent = error.message;
    card.appendChild(msg);

    if (onRetry && error.kind !== 'rate-limited') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ml-summary-card__retry';
      retry.textContent = 'Reintentar';
      retry.addEventListener('click', onRetry);
      card.appendChild(retry);
    } else if (error.kind === 'rate-limited') {
      // 429: show a disabled retry so the user understands it is temporary.
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ml-summary-card__retry';
      retry.disabled = true;
      retry.textContent = 'Reintentar';
      card.appendChild(retry);
    }
  }

  function showResult(summary: ProxyResponse): void {
    setState('result');
    clear();
    const head = document.createElement('div');
    head.className = 'ml-summary-card__title';
    head.textContent = 'Resumen de opiniones';
    card.appendChild(head);

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
    card.appendChild(verdictBox);
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
    card.appendChild(section);
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
