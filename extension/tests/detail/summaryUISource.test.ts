// Summary UI — source selector, no-source-data fallback, and external-source
// attribution footer. Uses the global vitest jsdom document.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSummaryView } from '../../src/detail/summaryUI';
import type { ProxyResponse } from '../../src/detail/types';

const SOURCES = [
  { id: 'ml-internal', label: 'Mercado Libre' },
  { id: 'rtings', label: 'RTINGS' },
] as const;

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('summary UI — source selector', () => {
  it('renders a segmented pill per source with the active one pressed', () => {
    const view = createSummaryView(host, { sources: SOURCES, currentSource: 'ml-internal' });
    const pills = view.el.querySelectorAll('.ml-summary-card__source-pill');
    expect(pills).toHaveLength(2);
    expect(pills[0].getAttribute('aria-pressed')).toBe('true'); // ml-internal active
    expect(pills[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('fires onSourceChange when a DIFFERENT source is clicked', () => {
    const onSourceChange = vi.fn();
    const view = createSummaryView(host, { sources: SOURCES, currentSource: 'ml-internal', onSourceChange });
    const rtingsPill = view.el.querySelectorAll('.ml-summary-card__source-pill')[1] as HTMLButtonElement;
    rtingsPill.click();
    expect(onSourceChange).toHaveBeenCalledWith('rtings');
  });

  it('does NOT fire onSourceChange when the active source is clicked', () => {
    const onSourceChange = vi.fn();
    const view = createSummaryView(host, { sources: SOURCES, currentSource: 'ml-internal', onSourceChange });
    const mlPill = view.el.querySelectorAll('.ml-summary-card__source-pill')[0] as HTMLButtonElement;
    mlPill.click();
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it('setActiveSource updates the pressed pill without firing onSourceChange', () => {
    const onSourceChange = vi.fn();
    const view = createSummaryView(host, { sources: SOURCES, currentSource: 'ml-internal', onSourceChange });
    view.setActiveSource('rtings');
    const pills = view.el.querySelectorAll('.ml-summary-card__source-pill');
    expect(pills[1].getAttribute('aria-pressed')).toBe('true');
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it('renders no selector when only one (or zero) source is given', () => {
    const view = createSummaryView(host, { sources: [SOURCES[0]] });
    expect(view.el.querySelector('.ml-summary-card__sources')).toBeNull();
  });
});

describe('summary UI — no-source-data fallback', () => {
  it('renders the fallback message + a switch-to-ML button', () => {
    const onSwitchToInternal = vi.fn();
    const view = createSummaryView(host, { sources: SOURCES, currentSource: 'rtings' });
    view.showNoSourceData({ label: 'RTINGS', onSwitchToInternal });
    expect(view.el.getAttribute('data-ml-summary')).toBe('no-source-data');
    expect(view.el.querySelector('.ml-summary-card__empty')?.textContent).toContain('RTINGS');
    const btn = view.el.querySelector('.ml-summary-card__switch') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onSwitchToInternal).toHaveBeenCalledTimes(1);
  });

  it('omits the switch button when no handler is given', () => {
    const view = createSummaryView(host, { sources: SOURCES });
    view.showNoSourceData({ label: 'RTINGS' });
    expect(view.el.querySelector('.ml-summary-card__switch')).toBeNull();
  });
});

describe('summary UI — external attribution footer', () => {
  function withMeta(url?: string): ProxyResponse {
    return {
      strongPoints: ['a'],
      weakPoints: ['b'],
      verdict: 'ok',
      sourceMeta: { sourceId: 'rtings', label: 'RTINGS', matched: true, ...(url ? { url } : {}) },
    };
  }

  it('renders a safe https link to the original analysis', () => {
    const view = createSummaryView(host, { sources: SOURCES });
    view.showResult(withMeta('https://www.rtings.com/headphones/reviews/jlab-audio/go-air-pop-true-wireless'));
    const link = view.el.querySelector('.ml-summary-card__attribution a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toContain('rtings.com');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.textContent).toContain('RTINGS');
  });

  it('does NOT render a link for a non-https url (falls back to text)', () => {
    const view = createSummaryView(host, { sources: SOURCES });
    view.showResult(withMeta('javascript:alert(1)'));
    expect(view.el.querySelector('.ml-summary-card__attribution a')).toBeNull();
    expect(view.el.querySelector('.ml-summary-card__attribution')?.textContent).toContain('RTINGS');
  });

  it('renders no attribution when there is no sourceMeta (ml-internal)', () => {
    const view = createSummaryView(host, { sources: SOURCES });
    view.showResult({ strongPoints: ['a'], weakPoints: [], verdict: 'ok' });
    expect(view.el.querySelector('.ml-summary-card__attribution')).toBeNull();
  });
});
