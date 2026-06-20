// Router tests (Pilar 2) — assert isDetailPageRoute separates PDPs from
// listings/other pages, isListingRoute is unchanged, and main() dispatches to
// the Pilar 2 pipeline on a PDP and to the Pilar 1 listing branch on a listing.
// The listing branch itself is covered by the Pilar 1 observe/toggle tests; here
// we only verify the ROUTING decision.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the branches so main() routing can be observed without real DOM/network
// side effects. vi.mock is hoisted before imports. The detail controller's
// destroy is a vi.fn so the pagehide-cleanup test (Issue 5a) can assert it is
// called when the listener fires.
vi.mock('../src/adapter/mercadolibre', () => ({
  findContainer: vi.fn(() => null),
}));
vi.mock('../src/observe', () => ({
  createReorderer: vi.fn(() => ({
    reorder() {},
    start() {},
    stop() {},
    destroy() {},
    updateConfig: vi.fn(),
  })),
}));
vi.mock('../src/ui/toggle', () => ({
  mountToggle: vi.fn(() => ({ on() {}, off() {}, destroy() {}, isOn: () => false })),
}));
vi.mock('../src/ui/prefsPanel', () => ({
  mountPrefsPanel: vi.fn(() => ({
    expand() {},
    collapse() {},
    destroy() {},
    isExpanded: () => false,
  })),
}));
vi.mock('../src/prefs/rankingPrefs', () => ({
  // Default config returned by the loadPrefs mock; tests override via
  // mockReturnValue to assert the wiring uses the LOADED config, not defaults.
  loadPrefs: vi.fn(() => ({ w1: 0.6, w2: 0.3, w3: 0.4, w4: 0.3, priorC: 5 })),
  savePrefs: vi.fn(),
}));
vi.mock('../src/detail', () => ({
  runDetailSummary: vi.fn(() => ({ destroy: vi.fn() })),
}));

import { main, isDetailPageRoute, isListingRoute } from '../src/content';
import { findContainer } from '../src/adapter/mercadolibre';
import { createReorderer } from '../src/observe';
import { mountToggle } from '../src/ui/toggle';
import { mountPrefsPanel } from '../src/ui/prefsPanel';
import { loadPrefs } from '../src/prefs/rankingPrefs';
import { runDetailSummary } from '../src/detail';
import type { RankConfig } from '../src/ranking/types';

const findContainerMock = findContainer as unknown as ReturnType<typeof vi.fn>;
const createReordererMock = createReorderer as unknown as ReturnType<typeof vi.fn>;
const mountToggleMock = mountToggle as unknown as ReturnType<typeof vi.fn>;
const mountPrefsPanelMock = mountPrefsPanel as unknown as ReturnType<typeof vi.fn>;
const loadPrefsMock = loadPrefs as unknown as ReturnType<typeof vi.fn>;
const runDetailSummaryMock = runDetailSummary as unknown as ReturnType<typeof vi.fn>;

describe('isDetailPageRoute — PDP detection', () => {
  it('detects articulo.* PDPs across TLDs', () => {
    expect(isDetailPageRoute('https://articulo.mercadolibre.com.mx/MLM1-x')).toBe(true);
    expect(isDetailPageRoute('https://articulo.mercadolibre.com.ar/MLA1-y')).toBe(true);
    expect(isDetailPageRoute('https://articulo.mercadolibre.com.br/MLB1-z')).toBe(true);
  });

  it('detects catalog /p/<id> PDPs with a leading product slug (real ML URLs)', () => {
    expect(
      isDetailPageRoute('https://www.mercadolibre.com.mx/audifonos-in-ear-1hora/p/MLM68725493'),
    ).toBe(true);
    expect(
      isDetailPageRoute('https://www.mercadolibre.com.mx/audifonos-in-ear-1hora/p/MLM68725493#reviews'),
    ).toBe(true);
    // bare /p/<id> short form still works
    expect(isDetailPageRoute('https://www.mercadolibre.com.mx/p/MLM123')).toBe(true);
    expect(isDetailPageRoute('https://mercadolibre.com.ar/p/MLA999')).toBe(true);
  });

  it('detects catalog /up/<id> PDPs (e.g. AR catalog URLs)', () => {
    expect(
      isDetailPageRoute('https://www.mercadolibre.com.ar/auriculares-smart/up/MLAU3842095417'),
    ).toBe(true);
  });

  it('rejects listing pages', () => {
    expect(isDetailPageRoute('https://listado.mercadolibre.com.mx/audifonos')).toBe(false);
    expect(isDetailPageRoute('https://listado.mercadolibre.com.ar/iphone')).toBe(false);
  });

  it('rejects the home page and other non-PDP routes', () => {
    expect(isDetailPageRoute('https://www.mercadolibre.com.mx/')).toBe(false);
    expect(isDetailPageRoute('https://mercadolibre.com.mx/ayuda')).toBe(false);
    expect(isDetailPageRoute('https://example.com/')).toBe(false);
  });

  it('rejects a path that contains /p/ but no ML id (avoids false positives)', () => {
    expect(isDetailPageRoute('https://www.mercadolibre.com.mx/ofertas/p/promociones')).toBe(false);
  });

  it('returns false on an invalid URL (never throws)', () => {
    expect(isDetailPageRoute('not-a-url')).toBe(false);
    expect(isDetailPageRoute('')).toBe(false);
  });
});

describe('isListingRoute — unchanged from Pilar 1', () => {
  it('detects listado.* hosts', () => {
    expect(isListingRoute('https://listado.mercadolibre.com.mx/audifonos')).toBe(true);
    expect(isListingRoute('https://listado.mercadolibre.com.ar/iphone#D[x]')).toBe(true);
  });

  it('rejects PDPs and other hosts', () => {
    expect(isListingRoute('https://articulo.mercadolibre.com.mx/MLM1')).toBe(false);
    expect(isListingRoute('https://www.mercadolibre.com.mx/')).toBe(false);
  });
});

describe('main() — routing dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('routes a listing to the Pilar 1 branch (findContainer + mountToggle), NOT the summary', () => {
    vi.stubGlobal('location', { href: 'https://listado.mercadolibre.com.mx/audifonos' });
    findContainerMock.mockReturnValue(document.createElement('ol'));

    main();

    expect(findContainerMock).toHaveBeenCalledWith(document);
    expect(mountToggleMock).toHaveBeenCalled();
    expect(runDetailSummaryMock).not.toHaveBeenCalled();
  });

  it('listing route wires loadPrefs -> createReorderer(container, config) -> mountToggle -> mountPrefsPanel (Phase 5.5)', () => {
    const loadedConfig: RankConfig = { w1: 0.9, w2: 0.2, w3: 0.4, w4: 0.5, priorC: 5 };
    loadPrefsMock.mockReturnValue(loadedConfig);
    const containerEl = document.createElement('ol');
    vi.stubGlobal('location', { href: 'https://listado.mercadolibre.com.mx/audifonos' });
    findContainerMock.mockReturnValue(containerEl);

    main();

    // loadPrefs runs FIRST so the initial render uses the persisted weights.
    expect(loadPrefsMock).toHaveBeenCalledTimes(1);
    // The reorderer is created with the LOADED config (not bare defaults).
    expect(createReordererMock).toHaveBeenCalledTimes(1);
    expect(createReordererMock).toHaveBeenCalledWith(containerEl, loadedConfig);
    // Toggle + panel are both mounted on a listing route (coexist).
    expect(mountToggleMock).toHaveBeenCalledWith(containerEl, createReordererMock.mock.results[0].value);
    expect(mountPrefsPanelMock).toHaveBeenCalledTimes(1);
    // The panel receives the loaded config as its initial slider state.
    const opts = mountPrefsPanelMock.mock.calls[0][0] as {
      initialConfig: RankConfig;
      onConfigChange: (c: RankConfig) => void;
    };
    expect(opts.initialConfig).toEqual(loadedConfig);
    expect(typeof opts.onConfigChange).toBe('function');
  });

  it('listing route wires onConfigChange -> reorderer.updateConfig (panel change re-ranks, zero network)', () => {
    loadPrefsMock.mockReturnValue({ w1: 0.6, w2: 0.3, w3: 0.4, w4: 0.3, priorC: 5 });
    vi.stubGlobal('location', { href: 'https://listado.mercadolibre.com.mx/audifonos' });
    findContainerMock.mockReturnValue(document.createElement('ol'));

    main();

    const reorderer = createReordererMock.mock.results[0].value as {
      updateConfig: ReturnType<typeof vi.fn>;
    };
    const opts = mountPrefsPanelMock.mock.calls[0][0] as {
      onConfigChange: (c: RankConfig) => void;
    };
    expect(reorderer.updateConfig).not.toHaveBeenCalled();

    const next: RankConfig = { w1: 1.0, w2: 0.1, w3: 0.4, w4: 0.1, priorC: 5 };
    opts.onConfigChange(next);

    expect(reorderer.updateConfig).toHaveBeenCalledTimes(1);
    expect(reorderer.updateConfig).toHaveBeenCalledWith(next);
  });

  it('routes a PDP to the Pilar 2 summary pipeline, NOT the listing branch', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });

    main();

    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    expect(findContainerMock).not.toHaveBeenCalled();
    expect(mountToggleMock).not.toHaveBeenCalled();
    expect(mountPrefsPanelMock).not.toHaveBeenCalled();
    expect(loadPrefsMock).not.toHaveBeenCalled();
  });

  it('routes a /p/ short URL to the Pilar 2 summary pipeline', () => {
    vi.stubGlobal('location', { href: 'https://www.mercadolibre.com.mx/p/MLM123' });
    main();
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('routes a real catalog PDP (slug + /p/<id>) to the Pilar 2 summary pipeline', () => {
    vi.stubGlobal('location', {
      href: 'https://www.mercadolibre.com.mx/audifonos-in-ear-1hora/p/MLM68725493#reviews',
    });
    main();
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    expect(findContainerMock).not.toHaveBeenCalled();
  });

  it('is a no-op on the home page (neither branch runs)', () => {
    vi.stubGlobal('location', { href: 'https://www.mercadolibre.com.mx/' });
    main();
    expect(findContainerMock).not.toHaveBeenCalled();
    expect(runDetailSummaryMock).not.toHaveBeenCalled();
    expect(mountPrefsPanelMock).not.toHaveBeenCalled();
    expect(loadPrefsMock).not.toHaveBeenCalled();
  });

  it('listing with no results container does not mount the toggle or the panel', () => {
    vi.stubGlobal('location', { href: 'https://listado.mercadolibre.com.mx/x' });
    findContainerMock.mockReturnValue(null);
    main();
    expect(findContainerMock).toHaveBeenCalled();
    expect(mountToggleMock).not.toHaveBeenCalled();
    expect(mountPrefsPanelMock).not.toHaveBeenCalled();
  });
});

describe('main() — bfcache (pagehide / pageshow)', () => {
  // jsdom may not ship a PageTransitionEvent constructor, so build a plain
  // Event and stamp `persisted` on it (the content.ts handlers read it back).
  function transitionEvent(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
    const ev = new Event(type);
    Object.defineProperty(ev, 'persisted', { value: persisted, configurable: true });
    return ev;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('registers both a pagehide and a pageshow listener on a PDP', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    expect(addSpy.mock.calls.filter((c) => c[0] === 'pagehide').length).toBe(1);
    expect(addSpy.mock.calls.filter((c) => c[0] === 'pageshow').length).toBe(1);
    addSpy.mockRestore();
  });

  it('pagehide with persisted=false destroys the controller (real unload) (Issue 5a)', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    const controller = runDetailSummaryMock.mock.results[0].value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pagehide')![1] as EventListener;
    expect(controller.destroy).not.toHaveBeenCalled();
    handler(transitionEvent('pagehide', false));
    expect(controller.destroy).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();
  });

  it('pagehide with persisted=true does NOT destroy (bfcache freeze keeps the card)', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    const controller = runDetailSummaryMock.mock.results[0].value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pagehide')![1] as EventListener;
    handler(transitionEvent('pagehide', true));
    // The page is frozen into bfcache, NOT unloaded — destroying here would
    // permanently lose the card on restore (content script does not re-run).
    expect(controller.destroy).not.toHaveBeenCalled();
    addSpy.mockRestore();
  });

  it('pageshow with persisted=true re-initializes the summary on a PDP (bfcache restore)', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    const firstController = runDetailSummaryMock.mock.results[0].value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pageshow')![1] as EventListener;

    handler(transitionEvent('pageshow', true));

    // Re-init: runDetailSummary called a second time (the card comes back).
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(2);
    // The previous controller was destroyed first (idempotent) so we never
    // keep two cards mounted — a single reference is replaced on re-init.
    expect(firstController.destroy).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();
  });

  it('pageshow with persisted=true does NOT re-init when a live card is still mounted (no quota waste)', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    const firstController = runDetailSummaryMock.mock.results[0].value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    // Simulate bfcache restoring the frozen DOM WITH the card alive.
    const liveCard = document.createElement('aside');
    liveCard.setAttribute('data-ml-summary', 'result');
    document.body.appendChild(liveCard);

    const handler = addSpy.mock.calls.find((c) => c[0] === 'pageshow')![1] as EventListener;
    handler(transitionEvent('pageshow', true));

    // A live card is present -> keep it: no re-init (no re-fetch / quota waste),
    // no destroy of the still-mounted controller.
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    expect(firstController.destroy).not.toHaveBeenCalled();

    liveCard.remove();
    addSpy.mockRestore();
  });

  it('pageshow with persisted=false does NOT re-init (normal load, not bfcache restore)', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pageshow')![1] as EventListener;
    handler(transitionEvent('pageshow', false));
    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();
  });

  it('pageshow with persisted=true does NOT re-init on a non-PDP (guard re-checks route)', () => {
    vi.stubGlobal('location', { href: 'https://www.mercadolibre.com.mx/' });
    const addSpy = vi.spyOn(window, 'addEventListener');
    main();
    // Non-PDP -> no detail controller, no pageshow handler registered.
    expect(addSpy.mock.calls.filter((c) => c[0] === 'pageshow').length).toBe(0);
    expect(runDetailSummaryMock).not.toHaveBeenCalled();
    addSpy.mockRestore();
  });
});