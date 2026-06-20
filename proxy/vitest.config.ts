import { defineConfig } from 'vitest/config';

// Server-side tests: Node environment (global fetch/Response are available on
// Node 18+; the proxy never touches the DOM). fetch is mocked per-test.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
