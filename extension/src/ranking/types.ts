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
  /** Whether the card is a sponsored / "Patrocinado" listing. */
  sponsored: boolean;
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

/** Hardcoded ranking weights. */
export type RankConfig = {
  w1: number;
  w2: number;
  w3: number;
};

/** Page-level price statistics used for z-score normalization. */
export type PageStats = {
  mean: number;
  stddev: number;
};
