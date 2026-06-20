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
  createReorderer: vi.fn(() => ({ reorder() {}, start() {}, stop() {}, destroy() {} })),
}));
vi.mock('../src/ui/toggle', () => ({
  mountToggle: vi.fn(() => ({ on() {}, off() {}, destroy() {}, isOn: () => false })),
}));
vi.mock('../src/detail', () => ({
  runDetailSummary: vi.fn(() => ({ destroy: vi.fn() })),
}));

import { main, isDetailPageRoute, isListingRoute } from '../src/content';
import { findContainer } from '../src/adapter/mercadolibre';
import { mountToggle } from '../src/ui/toggle';
import { runDetailSummary } from '../src/detail';

const findContainerMock = findContainer as unknown as ReturnType<typeof vi.fn>;
const mountToggleMock = mountToggle as unknown as ReturnType<typeof vi.fn>;
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

  it('routes a PDP to the Pilar 2 summary pipeline, NOT the listing branch', () => {
    vi.stubGlobal('location', { href: 'https://articulo.mercadolibre.com.mx/MLM123-x' });

    main();

    expect(runDetailSummaryMock).toHaveBeenCalledTimes(1);
    expect(findContainerMock).not.toHaveBeenCalled();
    expect(mountToggleMock).not.toHaveBeenCalled();
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
  });

  it('listing with no results container does not mount the toggle', () => {
    vi.stubGlobal('location', { href: 'https://listado.mercadolibre.com.mx/x' });
    findContainerMock.mockReturnValue(null);
    main();
    expect(findContainerMock).toHaveBeenCalled();
    expect(mountToggleMock).not.toHaveBeenCalled();
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