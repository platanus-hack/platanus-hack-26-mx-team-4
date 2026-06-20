// Toggle UI tests — assert ON applies the ranked order and OFF restores the
// EXACT original order captured at mount (spec: "Visible Toggle and Exact
// Restore"). The fixture is the source of truth for the card structure.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { findContainer, parseCards } from '../../src/adapter/mercadolibre';
import { rank } from '../../src/ranking/score';
import { RANK_CONFIG } from '../../src/config';
import { createReorderer } from '../../src/observe';
import { mountToggle, type ToggleController } from '../../src/ui/toggle';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'fixtures', 'ml-search.html');
const html = readFileSync(fixturePath, 'utf8');

let dom: JSDOM;
let fixtureDoc: Document;
let container: HTMLElement;
let toggle: ToggleController;

function freshFixture(): void {
  // A real listing URL gives jsdom a non-opaque origin (see observe.test.ts).
  dom = new JSDOM(html, { url: 'https://listado.mercadolibre.com.ar/' });
  fixtureDoc = dom.window.document;
  const found = findContainer(fixtureDoc);
  expect(found).not.toBeNull();
  container = found!;
}

function cardIds(root: ParentNode = container): string[] {
  return parseCards(root).map((c) => c.id);
}

describe('toggle UI — fixture-grounded', () => {
  beforeEach(() => {
    freshFixture();
    toggle = mountToggle(container, createReorderer(container));
  });

  afterEach(() => {
    toggle.destroy();
    // Clean the global jsdom document (the pill is appended to document.body).
    document.body.innerHTML = '';
  });

  it('mounts a visible, labeled pill in the document body', () => {
    const pill = document.body.querySelector('.ml-rerank-toggle');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('data-ml-rerank-state')).toBe('off');
    expect(pill!.getAttribute('aria-pressed')).toBe('false');
    expect(pill!.textContent).toContain('Re-rank: OFF');
  });

  it('starts OFF and leaves the original order untouched at mount', () => {
    const original = cardIds();
    expect(toggle.isOn()).toBe(false);
    expect(cardIds()).toEqual(original);
  });

  it('ON applies the ranked order and flips the pill state', () => {
    const expectedRankedIds = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

    toggle.on();

    expect(toggle.isOn()).toBe(true);
    expect(cardIds()).toEqual(expectedRankedIds);
    const pill = document.body.querySelector('.ml-rerank-toggle')!;
    expect(pill.getAttribute('data-ml-rerank-state')).toBe('on');
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(pill.textContent).toContain('Re-rank: ON');
  });

  it('OFF restores the EXACT original order captured at mount (incl. ties & sponsored)', () => {
    const original = cardIds(); // captured at mount, before any reorder

    toggle.on();
    expect(cardIds()).not.toEqual(original); // ranking changed the order

    toggle.off();
    expect(toggle.isOn()).toBe(false);
    expect(cardIds()).toEqual(original); // exact restore
  });

  it('ON -> OFF -> ON is stable across cycles', () => {
    const original = cardIds();
    const ranked = rank(parseCards(container), RANK_CONFIG).map((c) => c.id);

    toggle.on();
    expect(cardIds()).toEqual(ranked);
    toggle.off();
    expect(cardIds()).toEqual(original);
    toggle.on();
    expect(cardIds()).toEqual(ranked);
    toggle.off();
    expect(cardIds()).toEqual(original);
  });

  it('destroy() removes the pill and restores the original order', () => {
    const original = cardIds();
    toggle.on();
    toggle.destroy();

    expect(document.body.querySelector('.ml-rerank-toggle')).toBeNull();
    expect(cardIds()).toEqual(original);
  });
});
