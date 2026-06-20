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

// Phase 6.2 — prefs persistence invariant (spec: "Permission invariant"):
// personalized ranking stores preferences in the PAGE's localStorage (shared
// by content scripts at the page origin, same opaque-origin fallback as the
// toggle), so the manifest MUST gain NO new permission for it — in particular
// no `storage` API permission and no new host_permission. This pins that
// invariant against future regressions (e.g. someone reaching for
// chrome.storage would add `storage` and break Pilar 1's permission-free
// promise).
describe('manifest — prefs persistence adds NO permission (Phase 6.2)', () => {
  it('declares NO `storage` permission (prefs use page localStorage, not chrome.storage)', () => {
    // No `permissions` array at all -> `storage` cannot be present.
    expect(extra.permissions).toBeUndefined();
    const serialized = JSON.stringify(m);
    expect(serialized).not.toMatch(/\bstorage\b/);
  });

  it('keeps host_permissions unchanged (no new host for prefs)', () => {
    // Still exactly the single Vercel proxy host_permission from Pilar 2 —
    // prefs added nothing here.
    expect(m.host_permissions).toEqual(['https://hackaton-two-delta.vercel.app/*']);
  });

  it('the permissions array (if introduced later) would not include storage — snapshot baseline', () => {
    // Baseline: there is currently no permissions field. If a future change
    // adds one, it must NOT contain `storage`; this asserts the current
    // unchanged state so any delta is caught.
    expect(extra.permissions).toBeUndefined();
  });
});