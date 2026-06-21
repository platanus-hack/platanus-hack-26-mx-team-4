// Detail-pipeline shared types (Pilar 2 — ML Review Summary).
// Pure data contracts; no DOM, no globals, no network. Every other detail
// module operates on these shapes so the core stays unit-testable in isolation.
//
// Contract (per spec "Proxy Request and Response Contract" + "LLM Summary
// Contract"):
//   - The extension POSTs ONLY public product context + review texts to the
//     Vercel proxy. The Gemini API key NEVER appears here (it is server-side).
//   - The summary is exactly strong points / weak points / verdict.

/**
 * Identifier of an analysis source the user can switch between. `ml-internal`
 * is the built-in MercadoLibre reviews path (extracted in the extension);
 * external sources (e.g. `rtings`) are fetched + normalized SERVER-SIDE in the
 * proxy (CORS + host-permission reasons — see proxy/api/sources/). Typed as a
 * union with `string` so new sources are addable without a breaking change.
 */
export type SourceId = 'ml-internal' | 'rtings' | (string & {});

/** A product identity the proxy uses to look a product up on an external source. */
export type ProductQuery = {
  brand?: string;
  model?: string;
  /** Raw product title as shown on the PDP (fallback when brand/model absent). */
  title?: string;
  gtin?: string;
};

/** A single review as the extension extracts it from the PDP. */
export type ReviewText = {
  /** Star rating 0..5 when visible, or null when the review shows none. */
  rating: number | null;
  /** The review body text. Always required (a review without text is useless). */
  text: string;
  /** Optional human-readable date string as shown on the PDP. */
  date?: string;
};

/**
 * A review normalized from ANY source into the lowest-common-denominator shape
 * the summary engine consumes. Extends ReviewText with provenance: `kind`
 * distinguishes a user review (MercadoLibre) from an expert/editorial one
 * (RTINGS). `rating` is ALWAYS normalized to a 0..5 scale regardless of the
 * source's native scale (RTINGS' 0..10 is halved before it lands here).
 */
export type NormalizedReview = {
  rating: number | null;
  text: string;
  date?: string;
  kind?: 'user' | 'expert';
};

/**
 * The normalized result of querying one source for one product. Produced by a
 * source adapter (extension-side for `ml-internal`, proxy-side for externals).
 * `productMatched` is the fallback signal: when false the source has no analysis
 * for this product and the UI renders the "no data" state instead of a summary.
 */
export type NormalizedAnalysis = {
  sourceId: SourceId;
  sourceLabel: string;
  sourceUrl?: string;
  productMatched: boolean;
  /** 0..1 confidence of the product match (conservative threshold gates it). */
  matchConfidence?: number;
  reviews: NormalizedReview[];
  /** Best-effort structured expert scores (label + value on a 0..max scale). */
  scores?: { label: string; value: number; max: number }[];
  pros?: string[];
  cons?: string[];
};

/**
 * Request body the extension sends to the Vercel proxy. Contains ONLY public
 * data (product id/title/locale + review texts). No secrets, no auth tokens.
 */
export type ProxyRequest = {
  /**
   * Which source to summarize. `ml-internal` (default) carries `reviews`
   * extracted by the extension; an external source (e.g. `rtings`) carries a
   * `productQuery` instead, and the proxy fetches + normalizes that source.
   * Optional: when omitted the proxy defaults to `ml-internal` (back-compat).
   */
  source?: SourceId;
  productId: string;
  productTitle: string;
  locale?: string;
  /** Required for `ml-internal`; omitted for external sources. */
  reviews?: ReviewText[];
  /** Required for external sources so the proxy can look the product up. */
  productQuery?: ProductQuery;
};

/**
 * Structured summary the proxy returns. The Gemini responseSchema enforces this
 * shape server-side; the extension validates it again defensively (never trusts
 * the wire blindly).
 */
export type ProxyResponse = {
  strongPoints: string[];
  weakPoints: string[];
  verdict: string;
  /**
   * Optional provenance for the UI: which source produced this summary, a label
   * to display, a link back to the original analysis, and whether the product
   * was matched. Optional so the existing `ml-internal` contract is unchanged.
   */
  sourceMeta?: { sourceId: SourceId; label: string; url?: string; matched: boolean };
};

/**
 * Per-product cached summary in page localStorage. `timestamp` + `ttlMs` decide
 * freshness; `data` is the rendered summary. Versioned via the cache key prefix
 * (`ml-summary:v1:<productId>`), not a field here, so a contract bump just
 * changes the prefix and orphan keys age out.
 */
export type CacheEntry = {
  timestamp: number;
  ttlMs: number;
  data: ProxyResponse;
};

/**
 * Review context extracted from a PDP by the adapter. The pipeline turns this
 * into a ProxyRequest (dropping the hint flag, which is UI-only).
 */
export type ProductReviewData = {
  productId: string;
  productTitle: string;
  locale?: string;
  reviews: ReviewText[];
  /**
   * True when the PDP exposes a "Ver más" / load-more reviews control that the
   * user can expand. The pipeline surfaces this as a UI hint; it never
   * auto-clicks it (per design: "do not auto-click Ver más").
   */
  hasMoreReviewsHint: boolean;
};

/** Categorizes a summary failure so the UI can render the right state. */
export type SummaryErrorKind =
  | 'no-reviews' // PDP parsed but had zero review texts -> empty state
  | 'no-source-data' // external source has no analysis for this product -> fallback state
  | 'network' // fetch rejected / offline / DNS -> retryable
  | 'rate-limited' // proxy returned 429 -> retry disabled briefly
  | 'proxy-error' // proxy returned 5xx / non-2xx -> retryable
  | 'malformed'; // proxy 2xx but body failed defensive parse -> not retryable

/** A typed summary failure carried through the pipeline to the UI renderer. */
export type SummaryError = {
  kind: SummaryErrorKind;
  message: string;
};
