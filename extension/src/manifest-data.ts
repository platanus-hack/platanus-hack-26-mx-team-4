// Plain manifest object — the single source of truth for the extension's MV3
// manifest. `manifest.config.ts` wraps this with `defineManifest` for the
// @crxjs/vite-plugin build. Tests audit THIS object directly so they never load
// the crxjs/esbuild pipeline inside jsdom (which breaks a TextEncoder/Uint8Array
// realm invariant).
//
// Pilar 1 (listings): permission-free re-ranking of the page DOM.
// Pilar 2 (PDP review summary): ONE network call to a Vercel proxy that holds
// the Gemini key server-side. That requires a single host_permission for the
// EXACT proxy domain — no TLD wildcards (Chrome rejects them), no `storage`
// (the cache uses the page's localStorage, shared by content scripts at the
// page origin), no `background`/service_worker. The 16 per-TLD `matches`
// already cover PDP URLs (articulo.* / /p/); the route is detected in
// src/content.ts because match patterns cannot express ML's route variants.

export interface ManifestData {
  manifest_version: number;
  name: string;
  version: string;
  description: string;
  host_permissions?: string[];
  content_scripts: Array<{
    matches: string[];
    js: string[];
    css: string[];
    run_at: string;
  }>;
}

export const manifestData: ManifestData = {
  manifest_version: 3,
  name: 'ML Re-rank',
  version: '0.1.0',
  description: 'Re-ranks MercadoLibre search results and summarizes PDP reviews.',
  // Pilar 2: the ONLY new permission. Exact proxy host, no wildcards beyond the
  // path. If the Vercel hostname changes, update this AND PROXY_BASE in
  // src/detail/proxyClient.ts together (the manifest audit test enforces this).
  host_permissions: ['https://hackaton-two-delta.vercel.app/*'],
  content_scripts: [
    {
      // Chrome does NOT support TLD wildcards, so the major ML country TLDs are
      // enumerated explicitly. The leading "*." covers listado.*, www.*,
      // articulo.*, and bare mercadolibre.<tld>.
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
};
