// parseProxyResponse tests — the defensive parser must accept valid summaries,
// tolerate mild garbage, and reject malformed payloads with a typed
// SummaryError (never throw). It is the shared contract for the proxy client
// and the cache.

import { describe, it, expect } from 'vitest';
import { parseProxyResponse, isProxyResponse } from '../../src/detail/parseProxyResponse';
import type { ProxyResponse } from '../../src/detail/types';

const VALID: ProxyResponse = {
  strongPoints: ['Buena batería', 'Sonido claro'],
  weakPoints: ['Cable corto'],
  verdict: 'Relación calidad-precio sólida.',
};

describe('isProxyResponse — structural guard', () => {
  it('accepts a well-formed summary', () => {
    expect(isProxyResponse(VALID)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isProxyResponse(null)).toBe(false);
    expect(isProxyResponse('x')).toBe(false);
    expect(isProxyResponse(42)).toBe(false);
  });

  it('rejects when any section is not a string array', () => {
    expect(isProxyResponse({ ...VALID, strongPoints: 'no array' })).toBe(false);
    expect(isProxyResponse({ ...VALID, weakPoints: 5 })).toBe(false);
  });

  it('rejects a non-string verdict', () => {
    expect(isProxyResponse({ strongPoints: [], weakPoints: [], verdict: 5 })).toBe(false);
  });

  it('rejects an empty verdict (the verdict is the headline)', () => {
    expect(isProxyResponse({ strongPoints: [], weakPoints: [], verdict: '' })).toBe(false);
    expect(isProxyResponse({ strongPoints: [], weakPoints: [], verdict: '   ' })).toBe(false);
  });

  it('accepts empty point arrays (valid but no points)', () => {
    expect(isProxyResponse({ strongPoints: [], weakPoints: [], verdict: 'Sin datos.' })).toBe(true);
  });
});

describe('parseProxyResponse — valid payloads', () => {
  it('passes a valid object through unchanged', () => {
    const r = parseProxyResponse(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(VALID);
  });

  it('accepts a valid JSON string', () => {
    const r = parseProxyResponse(JSON.stringify(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(VALID);
  });

  it('keeps only string items, dropping non-string garbage from arrays', () => {
    const r = parseProxyResponse({
      strongPoints: ['ok', 7, null, 'otro'],
      weakPoints: ['x', true],
      verdict: 'veredicto',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.strongPoints).toEqual(['ok', 'otro']);
      expect(r.data.weakPoints).toEqual(['x']);
    }
  });
});

describe('parseProxyResponse — malformed payloads (never throw)', () => {
  it('rejects invalid JSON string with a malformed error', () => {
    const r = parseProxyResponse('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('rejects a non-object payload', () => {
    const r = parseProxyResponse(42);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('rejects null', () => {
    expect(parseProxyResponse(null).ok).toBe(false);
  });

  it('rejects a missing verdict', () => {
    const r = parseProxyResponse({ strongPoints: ['a'], weakPoints: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('rejects a missing section', () => {
    const r = parseProxyResponse({ strongPoints: ['a'], verdict: 'v' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed');
  });

  it('never throws on deeply weird input', () => {
    expect(() => parseProxyResponse(undefined)).not.toThrow();
    expect(() => parseProxyResponse([])).not.toThrow();
    expect(() => parseProxyResponse({})).not.toThrow();
  });
});
