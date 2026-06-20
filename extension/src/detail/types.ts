// Detail-pipeline shared types (Pilar 2 — ML Review Summary).
// Pure data contracts; no DOM, no globals, no network. Every other detail
// module operates on these shapes so the core stays unit-testable in isolation.
//
// Contract (per spec "Proxy Request and Response Contract" + "LLM Summary
// Contract"):
//   - The extension POSTs ONLY public product context + review texts to the
//     Vercel proxy. The Gemini API key NEVER appears here (it is server-side).
//   - The summary is exactly strong points / weak points / verdict.

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
 * Request body the extension sends to the Vercel proxy. Contains ONLY public
 * data (product id/title/locale + review texts). No secrets, no auth tokens.
 */
export type ProxyRequest = {
  productId: string;
  productTitle: string;
  locale?: string;
  reviews: ReviewText[];
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
  | 'network' // fetch rejected / offline / DNS -> retryable
  | 'rate-limited' // proxy returned 429 -> retry disabled briefly
  | 'proxy-error' // proxy returned 5xx / non-2xx -> retryable
  | 'malformed'; // proxy 2xx but body failed defensive parse -> not retryable

/** A typed summary failure carried through the pipeline to the UI renderer. */
export type SummaryError = {
  kind: SummaryErrorKind;
  message: string;
};
