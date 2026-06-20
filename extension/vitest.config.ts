import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Give the GLOBAL jsdom a real listing URL so window.localStorage is
    // available (non-opaque origin). The toggle persists state to the page's
    // localStorage, which in tests resolves to this global window. Without a
    // real URL, jsdom throws on localStorage access (opaque origin) — see the
    // jsdom opaque-origin discovery. Fixture containers still come from their
    // own JSDOM instances built in each test with the same URL.
    environmentOptions: {
      jsdom: { url: 'https://listado.mercadolibre.com.ar/' },
    },
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
