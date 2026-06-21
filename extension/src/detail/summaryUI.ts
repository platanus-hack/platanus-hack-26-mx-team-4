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

import type { ProxyResponse, SummaryError, SourceId } from './types';

/** State stamped on the card root so CSS + tests can read the current state. */
export type SummaryState = 'loading' | 'empty' | 'error' | 'result' | 'no-source-data';

/** A selectable source descriptor for the header selector. */
export interface SourceOption {
  id: SourceId;
  label: string;
}

/** Options to wire the source selector into the card header. */
export interface SummaryViewOptions {
  /** Sources to offer in the selector (omit/empty -> no selector rendered). */
  sources?: readonly SourceOption[];
  /** Initially-active source id. */
  currentSource?: SourceId;
  /** Called when the user picks a DIFFERENT source. */
  onSourceChange?: (source: SourceId) => void;
}

/** A mounted summary card bound to a host element. */
export interface SummaryView {
  /** The card root element (tagged data-ml-summary). */
  readonly el: HTMLElement;
  showLoading(): void;
  showEmpty(opts?: { hasMoreReviewsHint?: boolean }): void;
  showError(error: SummaryError, onRetry?: () => void): void;
  showResult(summary: ProxyResponse): void;
  /** External source has no analysis for this product (fallback state). */
  showNoSourceData(opts: { label: string; onSwitchToInternal?: () => void }): void;
  /** Reflect the active source in the selector (does NOT fire onSourceChange). */
  setActiveSource(source: SourceId): void;
  /** Remove the card from the DOM. */
  destroy(): void;
}

/** Above this many sources the selector renders as a dropdown instead of pills. */
const SEGMENTED_MAX = 3;

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
export function createSummaryView(host: HTMLElement, options: SummaryViewOptions = {}): SummaryView {
  const sources = options.sources ?? [];
  let activeSource: SourceId = options.currentSource ?? (sources[0]?.id ?? 'ml-internal');

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

  // Optional source selector (segmented pills, or a dropdown beyond SEGMENTED_MAX).
  // Sits on its own row under the title so it persists across state changes.
  const selector = sources.length > 1 ? buildSelector() : null;

  // Body: cleared + rebuilt on every state transition.
  const body = document.createElement('div');
  body.className = 'ml-summary-card__body';

  if (selector) card.append(header, selector.el, body);
  else card.append(header, body);
  host.appendChild(card);

  /** Build the source selector (pills or dropdown) wired to onSourceChange. */
  function buildSelector(): { el: HTMLElement; setActive(id: SourceId): void } {
    const wrap = document.createElement('div');
    wrap.className = 'ml-summary-card__sources';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Fuente de análisis');

    const emit = (id: SourceId): void => {
      if (id === activeSource) return; // no-op when already active
      options.onSourceChange?.(id);
    };

    if (sources.length <= SEGMENTED_MAX) {
      const pills = new Map<SourceId, HTMLButtonElement>();
      for (const s of sources) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'ml-summary-card__source-pill';
        pill.textContent = s.label;
        pill.dataset.sourceId = String(s.id);
        pill.setAttribute('aria-pressed', String(s.id === activeSource));
        pill.addEventListener('click', () => emit(s.id));
        pills.set(s.id, pill);
        wrap.appendChild(pill);
      }
      return {
        el: wrap,
        setActive(id) {
          for (const [sid, pill] of pills) pill.setAttribute('aria-pressed', String(sid === id));
        },
      };
    }

    // Dropdown variant (scales to many sources).
    const select = document.createElement('select');
    select.className = 'ml-summary-card__source-select';
    select.setAttribute('aria-label', 'Fuente de análisis');
    for (const s of sources) {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = s.label;
      if (s.id === activeSource) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => emit(select.value as SourceId));
    wrap.appendChild(select);
    return {
      el: wrap,
      setActive(id) {
        select.value = String(id);
      },
    };
  }

  function setActiveSource(id: SourceId): void {
    activeSource = id;
    selector?.setActive(id);
  }

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

    appendAttribution(summary.sourceMeta);
  }

  /** Append a "Basado en el análisis de <label> ↗" footer for external sources. */
  function appendAttribution(meta: ProxyResponse['sourceMeta']): void {
    if (!meta || !meta.label) return;
    const footer = document.createElement('div');
    footer.className = 'ml-summary-card__attribution';
    // Only render a link for a safe https URL; otherwise show plain text.
    const safeUrl = meta.url && /^https:\/\//i.test(meta.url) ? meta.url : null;
    if (safeUrl) {
      const prefix = document.createElement('span');
      prefix.textContent = 'Basado en el análisis de ';
      const link = document.createElement('a');
      link.href = safeUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${meta.label} ↗`;
      footer.append(prefix, link);
    } else {
      footer.textContent = `Basado en el análisis de ${meta.label}.`;
    }
    body.appendChild(footer);
  }

  function showNoSourceData(opts: { label: string; onSwitchToInternal?: () => void }): void {
    setState('no-source-data');
    clear();
    const msg = document.createElement('p');
    msg.className = 'ml-summary-card__empty';
    msg.textContent = `${opts.label} no tiene un análisis para este producto.`;
    body.appendChild(msg);
    if (opts.onSwitchToInternal) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ml-summary-card__switch';
      btn.textContent = 'Ver opiniones de Mercado Libre';
      btn.addEventListener('click', opts.onSwitchToInternal);
      body.appendChild(btn);
    }
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
    showNoSourceData,
    setActiveSource,
    destroy,
  };
}
