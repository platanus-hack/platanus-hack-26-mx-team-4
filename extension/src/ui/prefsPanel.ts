// Preferences panel UI (Phase 5) — a small collapsed square fixed bottom-
// right, ABOVE the existing toggle pill (coexists, does not break it). Click
// expands it (CSS animation via attribute/class toggle) into a panel with the
// 4 Spanish preset chips + sliders (w1/w2/w4 + w7 real-discount) + an "Envío
// rápido" binary switch (toggles the w5/w6 shipping boosts together). w3 and
// priorC stay advanced/defaulted. Collapse again on click/close.
//
// Every preset / slider change:
//   1. persists via savePrefs (page localStorage `ml-rerank:prefs:v1`, same
//      opaque-origin try/catch fallback as toggle.ts — Pilar 1, NO new perms),
//   2. calls onConfigChange(next) — the caller (content.ts) maps that to
//      `reorderer.updateConfig(next)`, which re-ranks the CURRENT DOM with ZERO
//      network calls (Pilar 1 invariant).
//
// Preset clicks fire immediately (discrete choice, no churn). Slider moves are
// DEBOUNCED (~200ms) so dragging a slider does not thrash the DOM on every
// pixel. Styling lives in src/content.css (.ml-rerank-prefs / __panel).
//
// Mounting mirrors src/ui/toggle.ts: the square + panel are appended to
// document.body (position:fixed) so they float over ML's UI regardless of
// layout shifts.

import type { RankConfig } from '../ranking/types';
import { RANK_CONFIG } from '../config';
import { presetToConfig, savePrefs } from '../prefs/rankingPrefs';

/** Debounce window for slider changes (ms) — coalesces drag bursts. */
const SLIDER_DEBOUNCE_MS = 200;

/**
 * Canonical Spanish preset chip labels (tasks #800 Phase 2.1 + design #799).
 * Matching against `presetToConfig` is accent/case-insensitive; the chips use
 * the exact canonical text so the UI and the stored keys stay robust.
 */
const PRESET_LABELS: readonly string[] = [
  'Balanceado',
  'Mejor valorados',
  'Más vendidos',
  'Económicos',
];

/** Weights exposed as sliders (w3 + priorC are advanced/defaulted). w7 (real
 *  discount) joins w1/w2/w4 as a bar; w5/w6 (shipping) are a binary switch. */
type SliderWeight = 'w1' | 'w2' | 'w4' | 'w7';
const SLIDER_WEIGHTS: readonly SliderWeight[] = ['w1', 'w2', 'w4', 'w7'];

/**
 * Human-friendly captions for the weight sliders. The internal config keys
 * are implementation jargon; users see plain Spanish words that say what each
 * factor actually weighs.
 */
const WEIGHT_LABELS: Record<SliderWeight, string> = {
  w1: 'Calificación',
  w2: 'Precio',
  w4: 'Ventas',
  w7: 'Descuento',
};

/** "Envío rápido" ON weights (free shipping w5 + Full w6), sourced from defaults. */
const SHIPPING_W5_ON = RANK_CONFIG.w5 ?? 0;
const SHIPPING_W6_ON = RANK_CONFIG.w6 ?? 0;

/** True when the shipping boosts are active in `config` (free shipping or Full). */
function shippingEnabled(config: RankConfig): boolean {
  return (config.w5 ?? 0) > 0 || (config.w6 ?? 0) > 0;
}

/** True when two configs are equal across all weighted fields (preset match). */
function sameConfig(a: RankConfig, b: RankConfig): boolean {
  return (
    a.w1 === b.w1 &&
    a.w2 === b.w2 &&
    a.w3 === b.w3 &&
    a.w4 === b.w4 &&
    a.priorC === b.priorC &&
    (a.w5 ?? 0) === (b.w5 ?? 0) &&
    (a.w6 ?? 0) === (b.w6 ?? 0) &&
    (a.w7 ?? 0) === (b.w7 ?? 0)
  );
}

/** The preset label whose config matches `config`, or null for a custom config. */
function matchingPreset(config: RankConfig): string | null {
  for (const label of PRESET_LABELS) {
    if (sameConfig(presetToConfig(label), config)) return label;
  }
  return null;
}

export interface PrefsPanelController {
  /** Expand the panel (show presets + sliders). No-op if already expanded. */
  expand(): void;
  /** Collapse the panel back to the collapsed square. No-op if already collapsed. */
  collapse(): void;
  /** Current expanded state. */
  isExpanded(): boolean;
  /** Remove the square + panel from the DOM and clear any pending debounce. */
  destroy(): void;
}

export interface MountPrefsPanelOptions {
  /**
   * Called with the next active config when the user picks a preset (immediate)
   * or settles a slider move (debounced ~200ms). The caller maps this to
   * `reorderer.updateConfig(next)`. ZERO network is the caller's invariant
   * (Pilar 1); this callback must never fetch.
   */
  onConfigChange: (config: RankConfig) => void;
  /**
   * Initial weights used to set slider positions and to source w3/priorC on the
   * first slider move. Defaults to a fresh copy of RANK_CONFIG. content.ts
   * passes `loadPrefs()` so the initial render reflects persisted weights.
   */
  initialConfig?: RankConfig;
}

/**
 * Inject the preferences panel and wire user input to `onConfigChange`. The
 * collapsed square and the expanded panel are siblings appended to
 * document.body. Returns a controller for programmatic use (and tests).
 */
export function mountPrefsPanel(options: MountPrefsPanelOptions): PrefsPanelController {
  const { onConfigChange } = options;
  // Fresh copy so the caller's object is never mutated by slider/preset edits.
  const initial: RankConfig = options.initialConfig ? { ...options.initialConfig } : { ...RANK_CONFIG };
  // The live config tracked across preset/slider changes. w3 and priorC are not
  // surfaced as sliders; they follow the last preset (or the initial config)
  // until a preset changes them.
  let currentConfig: RankConfig = { ...initial };
  let expanded = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- collapsed circular button (twin to the toggle, stacked above it) ---
  const square = document.createElement('button');
  square.type = 'button';
  square.className = 'ml-rerank-prefs';
  square.setAttribute('aria-expanded', 'false');
  square.setAttribute('aria-label', 'Abrir preferencias de re-ranking');
  square.title = 'Preferencias de re-ranking';
  const sqIcon = document.createElement('span');
  sqIcon.className = 'ml-rerank-prefs__icon';
  sqIcon.setAttribute('aria-hidden', 'true');
  // Inline import to avoid circular module ordering issues.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqIcon.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h10"/><circle cx="17" cy="6" r="2.2"/><path d="M4 12h6"/><circle cx="13" cy="12" r="2.2"/><path d="M4 18h12"/><circle cx="19" cy="18" r="2.2"/></svg>';
  square.appendChild(sqIcon);

  // --- expanded panel (sibling; interactive controls cannot live inside a button) ---
  const panelEl = document.createElement('div');
  panelEl.className = 'ml-rerank-prefs__panel';
  panelEl.setAttribute('data-ml-prefs-open', 'false');
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-label', 'Preferencias de re-ranking');

  // Header: title + close button.
  const header = document.createElement('div');
  header.className = 'ml-rerank-prefs__header';
  const title = document.createElement('span');
  title.className = 'ml-rerank-prefs__title';
  title.textContent = 'Preferencias';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ml-rerank-prefs__close';
  closeBtn.setAttribute('aria-label', 'Cerrar preferencias');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  header.append(title, closeBtn);

  // Preset chips group.
  const presetsWrap = document.createElement('div');
  presetsWrap.className = 'ml-rerank-prefs__presets';
  const presetsLabel = document.createElement('span');
  presetsLabel.className = 'ml-rerank-prefs__group-label';
  presetsLabel.textContent = 'Modos rápidos';
  presetsWrap.appendChild(presetsLabel);
  const chipWrap = document.createElement('div');
  chipWrap.className = 'ml-rerank-prefs__chips';
  // Track chips by label so the active one can be highlighted on selection.
  const chips: Record<string, HTMLButtonElement> = {};
  for (const label of PRESET_LABELS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ml-rerank-prefs__chip';
    chip.setAttribute('data-ml-preset', label);
    // aria-pressed doubles as the visual "selected" hook (styled in content.css).
    chip.setAttribute('aria-pressed', 'false');
    chip.textContent = label;
    chip.addEventListener('click', () => onPresetClick(label));
    chipWrap.appendChild(chip);
    chips[label] = chip;
  }
  presetsWrap.appendChild(chipWrap);

  // Sliders group (w1, w2, w4).
  const slidersWrap = document.createElement('div');
  slidersWrap.className = 'ml-rerank-prefs__sliders';
  const slidersLabel = document.createElement('span');
  slidersLabel.className = 'ml-rerank-prefs__group-label';
  slidersLabel.textContent = 'Ajuste manual';
  slidersWrap.appendChild(slidersLabel);
  const sliders: Record<SliderWeight, HTMLInputElement> = {} as Record<SliderWeight, HTMLInputElement>;
  for (const weight of SLIDER_WEIGHTS) {
    const row = document.createElement('label');
    row.className = 'ml-rerank-prefs__slider-row';
    const caption = document.createElement('span');
    caption.className = 'ml-rerank-prefs__slider-caption';
    caption.textContent = WEIGHT_LABELS[weight];
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '2';
    input.step = '0.1';
    input.className = 'ml-rerank-prefs__slider';
    input.setAttribute('data-ml-weight', weight);
    input.value = String(currentConfig[weight] ?? 0);
    input.setAttribute('aria-label', `Peso ${weight}`);
    input.addEventListener('input', () => onSliderInput());
    row.append(caption, input);
    slidersWrap.appendChild(row);
    sliders[weight] = input;
  }

  // "Envío rápido" binary switch — toggles BOTH shipping boosts (free shipping
  // w5 + Full w6) on/off together. Lives in the manual-adjust group below the
  // sliders. ON applies the default weights; OFF zeroes both.
  const switchRow = document.createElement('label');
  switchRow.className = 'ml-rerank-prefs__switch-row';
  const switchCaption = document.createElement('span');
  switchCaption.className = 'ml-rerank-prefs__slider-caption';
  switchCaption.textContent = 'Envío rápido';
  const shippingSwitch = document.createElement('input');
  shippingSwitch.type = 'checkbox';
  shippingSwitch.className = 'ml-rerank-prefs__switch';
  shippingSwitch.setAttribute('role', 'switch');
  shippingSwitch.setAttribute('data-ml-switch', 'shipping');
  shippingSwitch.setAttribute('aria-label', 'Priorizar envío rápido (gratis y Full)');
  shippingSwitch.addEventListener('change', () => onShippingToggle());
  const switchTrack = document.createElement('span');
  switchTrack.className = 'ml-rerank-prefs__switch-track';
  switchTrack.setAttribute('aria-hidden', 'true');
  switchRow.append(switchCaption, shippingSwitch, switchTrack);
  slidersWrap.appendChild(switchRow);

  panelEl.append(header, presetsWrap, slidersWrap);
  document.body.append(square, panelEl);

  function renderExpanded(): void {
    square.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    panelEl.setAttribute('data-ml-prefs-open', expanded ? 'true' : 'false');
  }

  function expand(): void {
    if (expanded) return;
    expanded = true;
    renderExpanded();
  }

  function collapse(): void {
    if (!expanded) return;
    expanded = false;
    renderExpanded();
  }

  /** Cancel any pending debounced slider flush (e.g. a preset preempts it). */
  function clearDebounce(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  /** Reflect `currentConfig`'s slider weights back into the slider thumbs. */
  function syncSliders(): void {
    for (const weight of SLIDER_WEIGHTS) {
      sliders[weight].value = String(currentConfig[weight] ?? 0);
    }
  }

  /** Reflect `currentConfig`'s shipping boosts into the "Envío rápido" switch. */
  function syncSwitch(): void {
    shippingSwitch.checked = shippingEnabled(currentConfig);
  }

  /**
   * Highlight the active preset chip (aria-pressed=true) and clear the rest.
   * `active = null` clears all chips — used when the config is custom (a slider
   * moved it off every preset).
   */
  function setActivePreset(active: string | null): void {
    for (const label of PRESET_LABELS) {
      chips[label].setAttribute('aria-pressed', label === active ? 'true' : 'false');
    }
  }

  /** Re-derive the active chip from the live config (preset match or custom). */
  function syncActivePreset(): void {
    setActivePreset(matchingPreset(currentConfig));
  }

  /** Commit a new config: track it, persist it, and notify the caller. */
  function commit(next: RankConfig): void {
    currentConfig = next;
    savePrefs(next);
    onConfigChange(next);
  }

  function onPresetClick(label: string): void {
    clearDebounce();
    const preset = presetToConfig(label);
    commit(preset);
    syncSliders(); // keep the sliders in sync with the chosen preset
    syncSwitch(); // and the shipping switch (presets restore default boosts)
    setActivePreset(label); // highlight the chosen chip, clear the others
  }

  /** Build the custom config from the current slider thumbs + advanced weights. */
  function sliderConfig(): RankConfig {
    return {
      // Spread the live config first so advanced/defaulted weights (w3, priorC,
      // and the shipping boosts w5/w6 — kept by the switch) are carried through;
      // a slider move never silently zeroes them.
      ...currentConfig,
      w1: parseFloat(sliders.w1.value) || 0,
      w2: parseFloat(sliders.w2.value) || 0,
      w4: parseFloat(sliders.w4.value) || 0,
      w7: parseFloat(sliders.w7.value) || 0,
    };
  }

  /** Toggle BOTH shipping boosts (w5 free shipping + w6 Full) on/off together. */
  function onShippingToggle(): void {
    clearDebounce();
    const on = shippingSwitch.checked;
    commit({
      ...currentConfig,
      w5: on ? SHIPPING_W5_ON : 0,
      w6: on ? SHIPPING_W6_ON : 0,
    });
    // Toggling shipping may move the config off (or back onto) a preset.
    syncActivePreset();
  }

  function onSliderInput(): void {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      commit(sliderConfig());
      // A manual slider move may match a preset exactly or be fully custom;
      // re-derive the highlight so a custom config clears every chip.
      syncActivePreset();
    }, SLIDER_DEBOUNCE_MS);
  }

  function destroy(): void {
    clearDebounce();
    square.remove();
    panelEl.remove();
  }

  square.addEventListener('click', () => {
    if (expanded) collapse();
    else expand();
  });
  closeBtn.addEventListener('click', collapse);

  renderExpanded();
  syncSliders();
  syncSwitch();
  syncActivePreset(); // highlight the chip matching the persisted/initial config

  return { expand, collapse, isExpanded: () => expanded, destroy };
}
