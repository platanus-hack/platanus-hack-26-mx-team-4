// Summary UI tests — assert each state renders the correct markup with the
// right state attribute, that LLM output is rendered as TEXT (not HTML), and
// that the retry button is wired / disabled for 429. Uses the global vitest
// jsdom document (the card is appended to a host element).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSummaryView } from '../../src/detail/summaryUI';
import type { ProxyResponse, SummaryError } from '../../src/detail/types';

const SUMMARY: ProxyResponse = {
  strongPoints: ['Buena batería', 'Sonido claro'],
  weakPoints: ['Cable corto'],
  verdict: 'Relación calidad-precio sólida.',
};

let host: HTMLElement;

describe('summary UI — state rendering', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts a card tagged data-ml-summary and starts in the loading state', () => {
    const view = createSummaryView(host);
    expect(view.el.classList.contains('ml-summary-card')).toBe(true);
    expect(view.el.getAttribute('data-ml-summary')).toBe('loading');
    expect(host.contains(view.el)).toBe(true);
  });

  it('showLoading renders the title + 3 skeleton lines', () => {
    const view = createSummaryView(host);
    view.showLoading();
    expect(view.el.getAttribute('data-ml-summary')).toBe('loading');
    expect(view.el.querySelector('.ml-summary-card__title')?.textContent).toBe('Resumen de opiniones');
    expect(view.el.querySelectorAll('.ml-summary-card__skeleton')).toHaveLength(3);
  });

  it('showEmpty renders the empty message (no broken markup)', () => {
    const view = createSummaryView(host);
    view.showEmpty();
    expect(view.el.getAttribute('data-ml-summary')).toBe('empty');
    expect(view.el.querySelector('.ml-summary-card__empty')?.textContent).toBe(
      'Aún no hay opiniones para resumir.',
    );
  });

  it('showEmpty with a hint renders the load-more hint text', () => {
    const view = createSummaryView(host);
    view.showEmpty({ hasMoreReviewsHint: true });
    expect(view.el.querySelector('.ml-summary-card__hint')).not.toBeNull();
  });

  it('showEmpty without a hint does not render the hint', () => {
    const view = createSummaryView(host);
    view.showEmpty();
    expect(view.el.querySelector('.ml-summary-card__hint')).toBeNull();
  });

  it('showResult renders strong, weak, and verdict sections', () => {
    const view = createSummaryView(host);
    view.showResult(SUMMARY);
    expect(view.el.getAttribute('data-ml-summary')).toBe('result');
    const strong = Array.from(view.el.querySelectorAll('.ml-summary-card__strong')).map((e) => e.textContent);
    expect(strong).toEqual(SUMMARY.strongPoints);
    const weak = Array.from(view.el.querySelectorAll('.ml-summary-card__weak')).map((e) => e.textContent);
    expect(weak).toEqual(SUMMARY.weakPoints);
    expect(view.el.querySelector('.ml-summary-card__verdict p')?.textContent).toBe(SUMMARY.verdict);
  });

  it('showResult renders "—" for an empty section (no points) instead of an empty list', () => {
    const view = createSummaryView(host);
    view.showResult({ strongPoints: [], weakPoints: [], verdict: 'Sin datos.' });
    expect(view.el.querySelectorAll('.ml-summary-card__section-empty')).toHaveLength(2);
    expect(view.el.querySelector('.ml-summary-card__verdict p')?.textContent).toBe('Sin datos.');
  });

  it('renders LLM output as TEXT, not HTML (no script/img injected)', () => {
    const view = createSummaryView(host);
    const malicious: ProxyResponse = {
      strongPoints: ['<img src=x onerror=alert(1)>', '<script>alert(2)</script>'],
      weakPoints: ['<b>bold</b>'],
      verdict: '<iframe src=evil></iframe>',
    };
    view.showResult(malicious);
    // No live elements were created from the strings.
    expect(view.el.querySelectorAll('script')).toHaveLength(0);
    expect(view.el.querySelectorAll('img')).toHaveLength(0);
    expect(view.el.querySelectorAll('iframe')).toHaveLength(0);
    // The raw strings are shown verbatim as text.
    const items = Array.from(view.el.querySelectorAll('.ml-summary-card__strong')).map((e) => e.textContent);
    expect(items).toEqual(malicious.strongPoints);
    expect(view.el.querySelector('.ml-summary-card__verdict p')?.textContent).toBe(malicious.verdict);
  });
});

describe('summary UI — error + retry', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('showError renders the error message + a retry button that calls onRetry', () => {
    const view = createSummaryView(host);
    let retried = 0;
    const error: SummaryError = { kind: 'proxy-error', message: 'El servicio falló.' };
    view.showError(error, () => {
      retried++;
    });
    expect(view.el.getAttribute('data-ml-summary')).toBe('error');
    expect(view.el.querySelector('.ml-summary-card__error')?.textContent).toBe('El servicio falló.');
    const btn = view.el.querySelector<HTMLButtonElement>('.ml-summary-card__retry');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);
    btn!.click();
    expect(retried).toBe(1);
  });

  it('showError for rate-limited (429) renders a calm hint and NO retry button', () => {
    const view = createSummaryView(host);
    const error: SummaryError = { kind: 'rate-limited', message: 'Límite de uso alcanzado.' };
    view.showError(error, () => {});
    // No dead/disabled button: retrying now won't help on a quota error.
    expect(view.el.querySelector('.ml-summary-card__retry')).toBeNull();
    const hint = view.el.querySelector('.ml-summary-card__hint');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe('Volvé a intentarlo más tarde.');
  });

  it('showError without an onRetry callback renders no retry button', () => {
    const view = createSummaryView(host);
    view.showError({ kind: 'malformed', message: 'Respuesta inválida.' });
    expect(view.el.querySelector('.ml-summary-card__retry')).toBeNull();
  });

  it('destroy removes the card from the host', () => {
    const view = createSummaryView(host);
    expect(host.contains(view.el)).toBe(true);
    view.destroy();
    expect(host.contains(view.el)).toBe(false);
  });

  it('state transitions replace the card children (no stale content leaks across states)', () => {
    const view = createSummaryView(host);
    view.showResult(SUMMARY);
    expect(view.el.querySelectorAll('.ml-summary-card__strong').length).toBe(2);
    view.showLoading();
    expect(view.el.querySelectorAll('.ml-summary-card__strong')).toHaveLength(0);
    expect(view.el.querySelectorAll('.ml-summary-card__skeleton')).toHaveLength(3);
  });
});

describe('summary UI — minimize / expand', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts a persistent header with a title and a minimize button (starts expanded)', () => {
    const view = createSummaryView(host);
    expect(view.el.querySelector('.ml-summary-card__header')).not.toBeNull();
    expect(view.el.querySelector('.ml-summary-card__title')?.textContent).toBe('Resumen de opiniones');
    const btn = view.el.querySelector<HTMLButtonElement>('.ml-summary-card__minimize');
    expect(btn).not.toBeNull();
    expect(view.el.getAttribute('data-ml-collapsed')).toBe('false');
    expect(btn!.getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking the minimize button collapses the card (hides the body)', () => {
    const view = createSummaryView(host);
    const btn = view.el.querySelector<HTMLButtonElement>('.ml-summary-card__minimize')!;
    btn.click();
    expect(view.el.getAttribute('data-ml-collapsed')).toBe('true');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('+');
  });

  it('clicking again expands the card back', () => {
    const view = createSummaryView(host);
    const btn = view.el.querySelector<HTMLButtonElement>('.ml-summary-card__minimize')!;
    btn.click();
    btn.click();
    expect(view.el.getAttribute('data-ml-collapsed')).toBe('false');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.textContent).toBe('–');
  });

  it('the header (title + minimize) survives state transitions', () => {
    const view = createSummaryView(host);
    view.showResult(SUMMARY);
    view.showEmpty();
    view.showError({ kind: 'malformed', message: 'x' });
    // One single persistent header/title/button across all state changes.
    expect(view.el.querySelectorAll('.ml-summary-card__header')).toHaveLength(1);
    expect(view.el.querySelectorAll('.ml-summary-card__title')).toHaveLength(1);
    expect(view.el.querySelectorAll('.ml-summary-card__minimize')).toHaveLength(1);
  });

  it('content renders inside the body container (not the header)', () => {
    const view = createSummaryView(host);
    view.showResult(SUMMARY);
    const body = view.el.querySelector('.ml-summary-card__body');
    expect(body).not.toBeNull();
    expect(body!.querySelector('.ml-summary-card__verdict')).not.toBeNull();
  });
});
