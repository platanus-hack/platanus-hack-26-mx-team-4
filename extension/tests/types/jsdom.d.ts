// Ambient type shim for `jsdom`.
//
// jsdom ships no bundled type declarations and `@types/jsdom` is not installed;
// tsconfig `types` is restricted to ["vitest/globals", "node"], so the bare
// `import { JSDOM } from 'jsdom'` in the fixture-grounded tests would otherwise
// fail typecheck (TS7016). This declares just the surface the tests use. It is
// type-only and erased at runtime; the real jsdom package is still imported.
declare module 'jsdom' {
  export class JSDOM {
    constructor(
      html?: string,
      options?: {
        url?: string;
        referrer?: string;
        contentType?: string;
        includeNodeLocations?: boolean;
        storageQuota?: number;
        runScripts?: 'outside-only' | 'dangerously';
        resources?: unknown;
        pretendToBeVisual?: boolean;
      },
    );
    readonly window: Window;
  }
}
