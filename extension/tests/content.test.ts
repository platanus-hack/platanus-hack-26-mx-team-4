// Router tests (Pilar 2) — assert isDetailPageRoute separates PDPs from
// listings/other pages, isListingRoute is unchanged, and main() dispatches to
// the Pilar 2 pipeline on a PDP and to the Pilar 1 listing branch on a listing.
// The listing branch itself is covered by the Pilar 1 observe/toggle tests; here
// we only verify the ROUTING decision.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the branches so main() routing can be observed without real DOM/network
// side effects. vi.mock is hoisted before imports.
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
  runDetailSummary: vi.fn(() => ({ destroy() {} })),
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