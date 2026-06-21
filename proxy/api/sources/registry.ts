// Server-side source registry (Pilar 2 — external opinions).
//
// Maps a SourceId to the adapter that fetches + normalizes that source on the
// SERVER (the extension cannot reach external sites directly). Adding a new
// external source = implement an adapter (like ./rtings) and register it here;
// the summarize handler dispatches through this map, so nothing else changes.
//
// `ml-internal` is NOT here: those reviews are extracted by the extension and
// arrive in the request body, so the proxy summarizes them directly without an
// adapter lookup.

import type { ProductQuery, NormalizedAnalysis } from './rtings.js';
import {
  fetchAnalysis as fetchRtings,
  RTINGS_SOURCE_ID,
  RTINGS_LABEL,
} from './rtings.js';

/** A server-side source adapter: look a product up and normalize the result. */
export interface ServerSourceAdapter {
  id: string;
  label: string;
  fetchAnalysis(query: ProductQuery, fetchImpl?: typeof fetch): Promise<NormalizedAnalysis>;
}

/** Registered external adapters, keyed by SourceId. */
export const SERVER_SOURCE_ADAPTERS: Record<string, ServerSourceAdapter> = {
  [RTINGS_SOURCE_ID]: {
    id: RTINGS_SOURCE_ID,
    label: RTINGS_LABEL,
    fetchAnalysis: fetchRtings,
  },
};

/** Look up a server-side adapter by source id (undefined when not external). */
export function getServerAdapter(sourceId: string): ServerSourceAdapter | undefined {
  return SERVER_SOURCE_ADAPTERS[sourceId];
}
