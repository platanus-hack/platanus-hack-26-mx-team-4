// Inline SVG icon strings reused across the floating UI (toggle, prefs, summary).
// Strings are static markup authored by us — never user/LLM content — so it is
// safe to assign them via innerHTML on small icon containers we create. Any
// untrusted text continues to flow through textContent elsewhere.

export const powerIcon = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3v9"/>
  <path d="M7.5 6.5a7 7 0 1 0 9 0"/>
</svg>`;

export const chevronIcon = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 9l6 6 6-6"/>
</svg>`;

export const sparkleIcon = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>
  <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/>
</svg>`;

export const slidersIcon = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 6h10"/><circle cx="17" cy="6" r="2.2"/>
  <path d="M4 12h6"/><circle cx="13" cy="12" r="2.2"/>
  <path d="M4 18h12"/><circle cx="19" cy="18" r="2.2"/>
</svg>`;

export const closeIcon = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 6l12 12M18 6L6 18"/>
</svg>`;
