// Source registry (extension side) tests — declares the selectable sources and
// classifies them as extension-local vs proxy-fetched (external).

import { describe, it, expect } from 'vitest';
import {
  UI_SOURCES,
  DEFAULT_SOURCE,
  getUiSource,
  isExternalSource,
} from '../../src/detail/sources/registry';

describe('UI source registry', () => {
  it('defaults to ml-internal as the first source', () => {
    expect(DEFAULT_SOURCE).toBe('ml-internal');
    expect(UI_SOURCES[0].id).toBe('ml-internal');
  });

  it('includes RTINGS as a proxy-fetched (external) source', () => {
    const rtings = getUiSource('rtings');
    expect(rtings).toBeDefined();
    expect(rtings!.label).toBe('RTINGS');
    expect(rtings!.location).toBe('proxy');
  });

  it('classifies sources by location', () => {
    expect(isExternalSource('ml-internal')).toBe(false);
    expect(isExternalSource('rtings')).toBe(true);
    expect(isExternalSource('unknown-source')).toBe(false);
  });

  it('returns undefined for an unknown source', () => {
    expect(getUiSource('nope')).toBeUndefined();
  });
});
