// Summary card UI (Pilar 2) — renders the LLM summary into the PDP with four
// states: loading (thinking dots + indeterminate bar), result (typewriter-
// animated strong/weak/verdict), empty (no reviews), and error (retryable /
// rate-limited).
//
// LAYOUT: a PERSISTENT header (sparkle + title + AI badge + circular chevron
// minimize) is created once and survives every state change; only the BODY is
// replaced per state. The minimize button toggles `data-ml-collapsed` on the
// card root (CSS hides the body when collapsed).
//
// TYPEWRITER: result text (verdict + each strong/weak bullet) is animated in
// cascade via src/ui/typewriter.ts. A single AbortController per view is
// recycled across state transitions so any in-flight typing animation is
// cancelled before the next render — prevents two animations writing to the
// same node.
//
// SECURITY: every user-facing string is written via textContent (the
// typewriter itself uses textContent internally). LLM strong/weak/verdict are
// treated as untrusted text — no innerHTML. The static SVG icon markup we
// inject via innerHTML is authored by us (src/ui/icons.ts) and contains no
// dynamic data.

<<<<<<< HEAD
import type { ProxyResponse, SummaryError } from './types';
import { typewriter, createCaret } from '../ui/typewriter';
import { sparkleIcon, chevronIcon } from '../ui/icons';

export type SummaryState = 'loading' | 'empty' | 'error' | 'result';
=======
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
>>>>>>> f2b775ec42721352c99ef6e60eae5a9fbd5372a0

export interface SummaryView {
  readonly el: HTMLElement;
  showLoading(): void;
  showEmpty(opts?: { hasMoreReviewsHint?: boolean }): void;
  showError(error: SummaryError, onRetry?: () => void): void;
  showResult(summary: ProxyResponse): void;
<<<<<<< HEAD
  destroy(): void;
}

=======
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
>>>>>>> f2b775ec42721352c99ef6e60eae5a9fbd5372a0
const SUMMARY_ATTR = 'data-ml-summary';
const COLLAPSED_ATTR = 'data-ml-collapsed';

<<<<<<< HEAD
export function createSummaryView(host: HTMLElement): SummaryView {
=======
/**
 * Create a summary card and append it to `host`. The card root + its header
 * (title + minimize button) are created once; only the BODY is replaced across
 * state transitions, so the minimize control persists and the pipeline observer
 * can ignore our own writes.
 */
export function createSummaryView(host: HTMLElement, options: SummaryViewOptions = {}): SummaryView {
  const sources = options.sources ?? [];
  let activeSource: SourceId = options.currentSource ?? (sources[0]?.id ?? 'ml-internal');

>>>>>>> f2b775ec42721352c99ef6e60eae5a9fbd5372a0
  const card = document.createElement('aside');
  card.className = 'ml-summary-card';
  card.setAttribute(SUMMARY_ATTR, 'loading');
  card.setAttribute(COLLAPSED_ATTR, 'false');

  // Persistent header: sparkle icon + title + AI badge + minimize chevron.
  const header = document.createElement('div');
  header.className = 'ml-summary-card__header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'ml-summary-card__title-wrap';

  const sparkle = document.createElement('span');
  sparkle.className = 'ml-summary-card__sparkle';
  sparkle.setAttribute('aria-hidden', 'true');
  sparkle.innerHTML = sparkleIcon;

  const title = document.createElement('div');
  title.className = 'ml-summary-card__title';
  title.textContent = 'Resumen de opiniones';

  const badge = document.createElement('span');
  badge.className = 'ml-summary-card__badge-ai';
  badge.textContent = 'AI';

  titleWrap.append(sparkle, title, badge);

  const minimize = document.createElement('button');
  minimize.type = 'button';
  minimize.className = 'ml-summary-card__minimize';
  minimize.setAttribute('aria-expanded', 'true');
  minimize.setAttribute('aria-label', 'Minimizar resumen');
  minimize.innerHTML = chevronIcon;
  minimize.addEventListener('click', toggleCollapsed);

<<<<<<< HEAD
  header.append(titleWrap, minimize);

=======
  // Optional source selector (segmented pills, or a dropdown beyond SEGMENTED_MAX).
  // Sits on its own row under the title so it persists across state changes.
  const selector = sources.length > 1 ? buildSelector() : null;

  // Body: cleared + rebuilt on every state transition.
>>>>>>> f2b775ec42721352c99ef6e60eae5a9fbd5372a0
  const body = document.createElement('div');
  body.className = 'ml-summary-card__body';

  if (selector) card.append(header, selector.el, body);
  else card.append(header, body);
  host.appendChild(card);

<<<<<<< HEAD
  // One AbortController per active render — cancel before next state transition
  // so in-flight typewriter animations stop cleanly (no leaks, no double-writes).
  let typingAbort: AbortController | null = null;

  function cancelTyping(): void {
    if (typingAbort) {
      typingAbort.abort();
      typingAbort = null;
    }
  }

  function newTypingSignal(): AbortSignal {
    cancelTyping();
    typingAbort = new AbortController();
    return typingAbort.signal;
=======
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
>>>>>>> f2b775ec42721352c99ef6e60eae5a9fbd5372a0
  }

  function toggleCollapsed(): void {
    const collapsed = card.getAttribute(COLLAPSED_ATTR) === 'true';
    const next = !collapsed;
    card.setAttribute(COLLAPSED_ATTR, String(next));
    minimize.setAttribute('aria-expanded', String(!next));
    minimize.setAttribute('aria-label', next ? 'Expandir resumen' : 'Minimizar resumen');
  }

  function clear(): void {
    cancelTyping();
    while (body.firstChild) body.removeChild(body.firstChild);
  }

  function setState(state: SummaryState): void {
    card.setAttribute(SUMMARY_ATTR, state);
  }

  function showLoading(): void {
    setState('loading');
    clear();
    const thinking = document.createElement('div');
    thinking.className = 'ml-summary-card__thinking';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'ml-summary-card__thinking-dot';
      thinking.appendChild(dot);
    }
    const label = document.createElement('span');
    label.className = 'ml-summary-card__thinking-label';
    label.textContent = 'Analizando opiniones…';
    thinking.appendChild(label);
    body.appendChild(thinking);

    const bar = document.createElement('div');
    bar.className = 'ml-summary-card__progress';
    const fill = document.createElement('span');
    fill.className = 'ml-summary-card__progress-fill';
    bar.appendChild(fill);
    body.appendChild(bar);
  }

  function showEmpty(opts?: { hasMoreReviewsHint?: boolean }): void {
    setState('empty');
    clear();
    const signal = newTypingSignal();
    const msg = document.createElement('p');
    msg.className = 'ml-summary-card__empty';
    body.appendChild(msg);
    typewriter(msg, 'Aún no hay opiniones para resumir.', { signal, caret: createCaret() });
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
    const signal = newTypingSignal();

    // Build a flat queue of (element, text) typing tasks so we can cascade them
    // sequentially. The first task starts immediately; each subsequent task
    // kicks off on the previous task's onDone, giving a natural "AI is writing"
    // cascade across pros → cons → verdict.
    const queue: { el: HTMLElement; text: string }[] = [];

    queue.push(...appendSection('Puntos a favor', 'ml-summary-card__strong', summary.strongPoints));
    queue.push(...appendSection('Puntos en contra', 'ml-summary-card__weak', summary.weakPoints));

    const verdictBox = document.createElement('div');
    verdictBox.className = 'ml-summary-card__verdict';
    const verdictLabel = document.createElement('span');
    verdictLabel.className = 'ml-summary-card__verdict-label';
    verdictLabel.textContent = 'Veredicto';
    const verdict = document.createElement('p');
    verdictBox.append(verdictLabel, verdict);
    body.appendChild(verdictBox);
<<<<<<< HEAD
    queue.push({ el: verdict, text: summary.verdict });

    function runNext(i: number): void {
      if (signal.aborted || i >= queue.length) return;
      const { el, text } = queue[i];
      typewriter(el, text, {
        signal,
        cps: 95,
        caret: createCaret(),
        onDone: () => runNext(i + 1),
      });
    }
    runNext(0);
=======

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
>>>>>>> f2b775ec42721352c99ef6e60eae5a9fbd5372a0
  }

  function appendSection(
    labelText: string,
    itemClass: string,
    items: string[],
  ): { el: HTMLElement; text: string }[] {
    const section = document.createElement('div');
    section.className = 'ml-summary-card__section';
    const label = document.createElement('div');
    label.className = 'ml-summary-card__section-label';
    label.textContent = labelText;
    section.appendChild(label);
    const tasks: { el: HTMLElement; text: string }[] = [];
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
        list.appendChild(li);
        tasks.push({ el: li, text: item });
      }
      section.appendChild(list);
    }
    body.appendChild(section);
    return tasks;
  }

  function destroy(): void {
    cancelTyping();
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
