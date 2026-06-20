import { defineManifest } from '@crxjs/vite-plugin';

// Manifest V3 - Pilar 1.
//
// Permission-free: NO permissions, NO host_permissions, NO service_worker,
// NO web_accessible_resources. The content script only reads/writes the page
// DOM it is injected into; it makes zero network calls.
//
// NOTE on match patterns: Chrome does NOT support TLD wildcards.
// (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns:
//  "Chrome doesn't support match patterns for top Level domains (TLD).")
// A host wildcard must be the first or only character of the host, so the
// design's single broad pattern (star-dot-mercadolibre-dot-star) is INVALID
// and would prevent the unpacked extension from loading. We instead enumerate
// the major MercadoLibre country TLDs explicitly. The leading "*." prefix
// covers listado.*, www.*, and bare mercadolibre.<tld>. The listing/search
// route is narrowed further by a guard in src/content.ts, because matches
// cannot reliably express ML's cross-country search path variants.
export default defineManifest({
  manifest_version: 3,
  name: 'ML Re-rank',
  version: '0.1.0',
  description: 'Re-ranks MercadoLibre search results by visible quality signals.',
  content_scripts: [
    {
      matches: [
        '*://*.mercadolibre.com.ar/*',
        '*://*.mercadolibre.com.mx/*',
        '*://*.mercadolibre.com.br/*',
        '*://*.mercadolibre.com/*',
        '*://*.mercadolibre.cl/*',
        '*://*.mercadolibre.com.co/*',
        '*://*.mercadolibre.com.uy/*',
        '*://*.mercadolibre.com.pe/*',
        '*://*.mercadolibre.com.ve/*',
        '*://*.mercadolibre.com.ec/*',
        '*://*.mercadolibre.com.bo/*',
        '*://*.mercadolibre.com.py/*',
        '*://*.mercadolibre.com.do/*',
        '*://*.mercadolibre.com.cr/*',
        '*://*.mercadolibre.com.gt/*',
        '*://*.mercadolibre.co/*',
      ],
      js: ['src/content.ts'],
      css: ['src/content.css'],
      run_at: 'document_idle',
    },
  ],
});
