// Ranking module — shared types.
// Pure data contracts; no DOM, no globals.

/**
 * Stable, serializable card signals extracted from a listing card.
 * The ranking module operates on this shape (or any superset of it) so it stays
 * 100% unit-testable without a DOM.
 */
export type CardSignals = {
  /** Stable per-card key (href). Also the stable tie-break anchor of last resort. */
  id: string;
  /** Rating 0..5, or null when the card shows no rating. */
  rating: number | null;
  /** Review count, or null when absent. Treated as 0 for tie-breaking. */
  reviewCount: number | null;
  /** Currency-agnostic numeric price, or null when not present. */
  price: number | null;
  /** Whether the card is a sponsored / "Promocionado" listing. */
  sponsored: boolean;
  /**
   * Whether the listing advertises free shipping ("Envío gratis" / "Llega
   * gratis ..."). Optional so plain test signals stay valid; the adapter always
   * populates it (missing -> treated as false).
   */
  freeShipping?: boolean;
  /**
   * Whether the listing ships via Mercado Envíos Full (fast, ML-fulfilled).
   * Optional (see `freeShipping`); the adapter always populates it.
   */
  full?: boolean;
  /**
   * Real discount fraction 0..1 derived from a struck previous price
   * ((previous - current) / previous), or 0 when there is no valid discount.
   * Optional (see `freeShipping`); the adapter always populates it.
   */
  discount?: number;
};

/**
 * A parsed card: signals plus the live DOM node reference used by the reorderer.
 * Produced ONLY by the adapter (the single selector-touching file).
 */
export type ParsedCard = CardSignals & {
  nodeRef: HTMLElement;
};

/**
 * A card with its computed quality score and original listing index.
 * `originalIndex` is assigned by `rank()` from input position and is the final
 * stable tie-break anchor.
 */
export type ScoredCard = ParsedCard & {
  qualityScore: number;
  originalIndex: number;
};

/**
 * Ranking weights (configurable). Defaults live in `src/config.ts`.
 *   w1     — shrunk-rating weight (dominant trust signal)
 *   w2     — price-quality ratio weight
 *   w3     — sponsored penalty
 *   w4     — log-sold volume weight
 *   priorC — Bayesian shrinkage prior (confidence strength for the page mean)
 *   w5     — free-shipping boost (binary: "Envío gratis")
 *   w6     — Mercado Envíos Full boost (binary: fast fulfillment)
 *   w7     — real-discount boost (0..1 fraction off a struck previous price)
 *
 * With `priorC = 0` and `w4 = 0` the v2 formula reduces to the v1 one
 * (`w1*ratingNorm + w2*priceNorm - w3*sponsoredPenalty`), preserving prior
 * importer behavior. w5/w6/w7 are optional (default 0 when absent) so existing
 * configs and tests stay valid; production defaults live in `src/config.ts`.
 */
export type RankConfig = {
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  priorC: number;
  w5?: number;
  w6?: number;
  w7?: number;
};

/**
 * Page-level statistics used for normalization.
 *   mean/stddev — over present prices (z-score price normalization)
 *   ratingMean  — mean over PRESENT (non-null, finite) ratings; 0 when none.
 *                 Null ratings are excluded (spec: rating=null scores 0).
 *   maxSales    — max non-negative sold count on the page; 0 when none.
 *   minSales    — min non-negative sold count on the page; 0 when none.
 *                 maxSales === minSales flags a degenerate (single-card /
 *                 all-equal) page, for which `logSalesNorm` returns 0.
 */
export type PageStats = {
  mean: number;
  stddev: number;
  ratingMean: number;
  maxSales: number;
  minSales: number;
};
