// Manifest entry for the @crxjs/vite-plugin build.
//
// The plain manifest object lives in src/manifest-data.ts (the single source of
// truth, also audited by tests). This file only wraps it with `defineManifest`
// so the crxjs vite plugin can build the extension. Keeping the data separate
// lets tests audit the manifest without loading the crxjs/esbuild pipeline
// inside jsdom (which breaks a TextEncoder/Uint8Array realm invariant).

import { defineManifest } from '@crxjs/vite-plugin';
import { manifestData } from './src/manifest-data';

// `manifestData` is typed with loose field types for the audit (e.g. run_at as
// string); crxjs expects strict literal unions, so bridge with a cast here.
export default defineManifest(
  manifestData as unknown as Parameters<typeof defineManifest>[0],
);
