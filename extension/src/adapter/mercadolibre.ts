// Site adapter — the ONLY file that touches MercadoLibre selectors.
//
// Every selector below was verified against the captured live fixture
// (tests/fixtures/ml-search.html, ~2.3 MB). The fixture is the contract; if a
// selector stops resolving against a freshly captured page, it is wrong and must
// be re-verified, never guessed.
//
// Verified structure (per the captured search page):
//   <ol class="ui-search-layout ui-search-layout--grid">           <- container
//     <li class="ui-search-layout__item">                          <- nodeRef (re-appended)
//       <div class="ui-search-result__wrapper ...">
//         <div class="andes-card poly-card ...">                   <- signals source
//           ...
//           <a class="poly-component__ads-promotions" aria-label="Promocionado">Ad</a>  (sponsored only)
//           <span class="poly-component__review-compacted">
//             <span class="polylabel-label">4.8</span>             <- rating
//             <span class="polylabel-label">| +50mil vendidos</span> <- sold count
//           </span>
//           <div class="poly-component__price">
//             <s class="andes-money-amount andes-money-amount--previous">...649...</s>
//             <div class="poly-price__current">
//               <span class="andes-money-amount">                      <- current price
//                 <span class="andes-money-amount__fraction">449</span>
//                 <span class="andes-money-amount__cents">01</span>
//               </span>
//             </div>
//           </div>
//         </div>
//       </div>
//     </li>
//
// IMPORTANT deviation from the spec text: the fixture exposes SOLD counts
// ("+Nmil vendidos" / "+N vendidos"), NOT "(123)" review counts. The fixture is
// the source of truth, so `reviewCount` is populated from the sold count, which
// is a strictly stronger reliability signal for ranking. The sponsored badge is
// labelled "Promocionado" (NOT "Patrocinado", as the spec/design assumed).

import type { ParsedCard } from '../ranking/types';

/** Selector for a listing card row (the element the reorderer re-appends). */
const CARD_ROW_SELECTOR = 'li.ui-search-layout__item';
/** Selector for the card root inside a row (where signals live). */
const CARD_ROOT_SELECTOR = '.poly-card';
/** Selector for the search-results container. */
const CONTAINER_SELECTOR = 'ol.ui-search-layout';

/**
 * Return the search-results container, or null when not found.
 *
 * Accepts an optional `Document` so adapter tests can pass a JSDOM instance
 * parsed from the captured fixture; production calls it with no argument and it
 * defaults to the live global `document`.
 */
export function findContainer(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(CONTAINER_SELECTOR);
}

/** Parse every listing card under `root` into stable card signals + DOM refs. */
export function parseCards(root: ParentNode): ParsedCard[] {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(CARD_ROW_SELECTOR));
  const cards: ParsedCard[] = [];

  rows.forEach((row, index) => {
    const card = row.querySelector<HTMLElement>(CARD_ROOT_SELECTOR);
    if (!card) return; // skip non-card rows (e.g. injected promos) without throwing

    cards.push({
      id: parseId(card, index),
      rating: parseRating(card),
      reviewCount: parseReviewCount(card),
      price: parsePrice(card),
      sponsored: parseSponsored(card),
      freeShipping: parseFreeShipping(card),
      full: parseFull(card),
      discount: parseDiscount(card),
      nodeRef: row,
    });
  });

  return cards;
}

// --- per-signal parsers (each null-safe: missing data -> null / 0, never NaN) ---

/** Stable per-card key = the title link href (organic PDP URL or sponsored mclics URL). */
function parseId(card: HTMLElement, fallbackIndex: number): string {
  const titleLink = card.querySelector<HTMLAnchorElement>('.poly-component__title');
  const href = titleLink?.getAttribute('href');
  if (href) return href;
  if (card.id) return card.id;
  return `ml-rerank-card-${fallbackIndex}`;
}

/** Rating 0..5 from the first `.polylabel-label` inside the review block, or null. */
function parseRating(card: HTMLElement): number | null {
  const review = card.querySelector('.poly-component__review-compacted');
  if (!review) return null;
  const labels = review.querySelectorAll('.polylabel-label');
  if (labels.length === 0) return null;
  const raw = labels[0].textContent ?? '';
  // Locale-robust: accept "4.8" and "4,8".
  const value = parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Reliability signal (sold count) from the second `.polylabel-label`, or 0.
 *
 * Fixture format: "| +50mil vendidos" | "| +1000 vendidos" | "| +100 vendidos".
 * "mil" is a thousands multiplier. Absent block or unparseable text -> 0.
 */
function parseReviewCount(card: HTMLElement): number {
  const review = card.querySelector('.poly-component__review-compacted');
  if (!review) return 0;
  const labels = review.querySelectorAll('.polylabel-label');
  if (labels.length < 2) return 0;
  return parseSoldCount(labels[1].textContent ?? '');
}

/** Parse "+Nmil vendidos" / "+N vendidos" into a comparable magnitude. */
function parseSoldCount(text: string): number {
  const match = text.match(/(\d+)/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n)) return 0;
  return /mil/i.test(text) ? n * 1000 : n;
}

/**
 * Current selling price (currency-agnostic numeric), or null.
 *
 * Picks the `.andes-money-amount` inside `.poly-component__price` that is NOT
 * the struck-through previous price (`--previous`), then combines the integer
 * fraction with the 2-digit cents. Thousands separators are stripped.
 */
function parsePrice(card: HTMLElement): number | null {
  const priceBox = card.querySelector('.poly-component__price');
  if (!priceBox) return null;

  const amounts = Array.from(priceBox.querySelectorAll<HTMLElement>('.andes-money-amount'));
  // Prefer the current (non-previous) amount; this is the one inside
  // .poly-price__current. Fall back to the first amount if none are flagged
  // previous (e.g. a non-discounted card with a single price).
  const current =
    amounts.find((a) => !a.classList.contains('andes-money-amount--previous')) ?? amounts[0];
  return amountValue(current ?? null);
}

/**
 * Numeric value of a single `.andes-money-amount` element: integer fraction plus
 * the optional 2-digit cents. Thousands separators are stripped. Returns null
 * when the fraction is missing/unparseable. Shared by `parsePrice` (current
 * amount) and `parseDiscount` (previous amount).
 */
function amountValue(amount: Element | null): number | null {
  if (!amount) return null;
  const fraction = parseIntegerText(amount.querySelector('.andes-money-amount__fraction'));
  if (fraction === null) return null;
  let value = fraction;
  const centsEl = amount.querySelector('.andes-money-amount__cents');
  if (centsEl) {
    const cents = parseIntegerText(centsEl);
    if (cents !== null) value = fraction + cents / 100;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * Free-shipping flag. ML renders shipping inside `.poly-component__shipping*`
 * (e.g. `poly-component__shipping-v2`) as a pill whose text reads "Envío gratis"
 * / "Llega gratis hoy". We treat the listing as free-shipping iff that block's
 * text contains "gratis" (accent-insensitive). Absent block -> false.
 */
function parseFreeShipping(card: HTMLElement): boolean {
  const shipping = card.querySelector('[class*="poly-component__shipping"]');
  if (!shipping) return false;
  return /gratis/i.test(shipping.textContent ?? '');
}

/**
 * Mercado Envíos Full flag (fast, ML-fulfilled). ML marks it with an icon whose
 * accessible label is "Enviado por FULL" inside the shipping block. We scan that
 * block (falling back to the whole card) for any `aria-label` containing the
 * standalone word "full" (case-insensitive). Absent -> false.
 */
function parseFull(card: HTMLElement): boolean {
  const shipping = card.querySelector('[class*="poly-component__shipping"]');
  const scope: ParentNode = shipping ?? card;
  return Array.from(scope.querySelectorAll<HTMLElement>('[aria-label]')).some((el) =>
    /\bfull\b/i.test(el.getAttribute('aria-label') ?? ''),
  );
}

/**
 * Real discount fraction in 0..1 from a struck previous price:
 *   (previous - current) / previous
 * Returns 0 when there is no previous price, the numbers don't parse, or the
 * "discount" is non-positive (current >= previous). This rewards a genuine
 * markdown off the listing's OWN prior price — distinct from `priceNorm`, which
 * compares against the page mean.
 */
function parseDiscount(card: HTMLElement): number {
  const priceBox = card.querySelector('.poly-component__price');
  if (!priceBox) return 0;
  const amounts = Array.from(priceBox.querySelectorAll<HTMLElement>('.andes-money-amount'));
  const previousEl = amounts.find((a) => a.classList.contains('andes-money-amount--previous'));
  const currentEl = amounts.find((a) => !a.classList.contains('andes-money-amount--previous'));
  const previous = amountValue(previousEl ?? null);
  const current = amountValue(currentEl ?? null);
  if (previous === null || current === null) return 0;
  if (previous <= 0 || current >= previous) return 0;
  return (previous - current) / previous;
}

/** Strip non-digits and parse a base-10 integer, or null when none present. */
function parseIntegerText(el: Element | null): number | null {
  if (!el || !el.textContent) return null;
  const digits = el.textContent.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/** A card is sponsored iff it carries the "Promocionado" ads-promotions badge. */
function parseSponsored(card: HTMLElement): boolean {
  return card.querySelector('.poly-component__ads-promotions') !== null;
}
