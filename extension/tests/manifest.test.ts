// Manifest audit (Pilar 2) — the ONLY new permission is the exact Vercel proxy
// host_permission. No `storage`, no `background`, no TLD wildcards, no API
// permissions, and NO Gemini key anywhere in the manifest artifacts. Also
// enforces that the proxy host in the manifest matches PROXY_BASE in the client
// (they must move together if the Vercel hostname changes).

import { describe, it, expect } from 'vitest';
import { manifestData as m } from '../src/manifest-data';
import { PROXY_BASE } from '../src/detail/proxyClient';

// `m` is the plain manifest object (source of truth); auditing it directly
// avoids loading the crxjs/esbuild pipeline inside jsdom. `permissions` and
// `background` are intentionally absent from the loose ManifestData type, so
// they are checked via a record cast.
const extra = m as unknown as Record<string, unknown>;

describe('manifest — minimal permission delta (Pilar 2)', () => {
  it('adds exactly one host_permission: the Vercel proxy domain', () => {
    expect(m.host_permissions).toEqual(['https://hackaton-two-delta.vercel.app/*']);
  });

  it('the host_permission matches PROXY_BASE used by the proxy client', () => {
    expect(m.host_permissions).toContain(`${PROXY_BASE}/*`);
  });

  it('uses NO broad TLD wildcard in host_permissions (exact host only)', () => {
    for (const h of m.host_permissions ?? []) {
      expect(h.startsWith('https://hackaton-two-delta.vercel.app/')).toBe(true);
    }
  });

  it('declares NO API permissions (no `permissions` field)', () => {
    expect(extra.permissions).toBeUndefined();
  });

  it('declares NO background service worker', () => {
    expect(extra.background).toBeUndefined();
  });

  it('keeps the 16 per-TLD content-script matches unchanged (PDPs already covered)', () => {
    expect(m.content_scripts).toHaveLength(1);
    const matches = m.content_scripts![0].matches!;
    expect(matches).toHaveLength(16);
    expect(matches.every((x: string) => x.startsWith('*://*.mercadolibre.'))).toBe(true);
  });

  it('the content script still runs at document_idle on src/content.ts with the CSS', () => {
    const cs = m.content_scripts![0];
    expect(cs.js).toEqual(['src/content.ts']);
    expect(cs.css).toEqual(['src/content.css']);
    expect(cs.run_at).toBe('document_idle');
  });

  it('contains NO Gemini key / secret anywhere in the manifest', () => {
    const serialized = JSON.stringify(m);
    expect(serialized).not.toMatch(/gemini/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/GEMINI_API_KEY/);
  });
});