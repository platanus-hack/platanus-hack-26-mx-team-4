// Source registry (extension side) — the list of analysis sources the user can
// switch between in the summary card. This is the SINGLE place that declares the
// available sources; the UI selector and the pipeline both read from here, so
// adding a future source = one entry (plus its proxy adapter for `proxy` ones).
//
// `location` says WHERE the source's data is produced:
//   - 'extension': reviews are extracted from the ML PDP in the content script
//     (ml-internal). The pipeline sends those reviews to the proxy to summarize.
//   - 'proxy': the source is fetched + normalized server-side (e.g. RTINGS). The
//     pipeline sends only a productQuery; the proxy does the lookup.

import type { SourceId } from '../types';

export interface UiSource {
  id: SourceId;
  label: string;
  location: 'extension' | 'proxy';
}

/** Available sources, in display order. First entry is the default. */
export const UI_SOURCES: readonly UiSource[] = [
  { id: 'ml-internal', label: 'Mercado Libre', location: 'extension' },
  { id: 'rtings', label: 'RTINGS', location: 'proxy' },
] as const;

/** The source selected on first render. */
export const DEFAULT_SOURCE: SourceId = 'ml-internal';

/** Look up a source descriptor by id. */
export function getUiSource(id: SourceId): UiSource | undefined {
  return UI_SOURCES.find((s) => s.id === id);
}

/** True when a source is fetched server-side (no PDP reviews needed). */
export function isExternalSource(id: SourceId): boolean {
  return getUiSource(id)?.location === 'proxy';
}
