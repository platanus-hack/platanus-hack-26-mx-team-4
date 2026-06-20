// Proxy client (Pilar 2) — the extension's ONLY network call.
//
// POSTs a ProxyRequest (public product context + review texts ONLY) to the
// Vercel proxy and defensively parses the response. The Gemini API key lives
// ONLY in the Vercel env var inside proxy/; it is NEVER imported here, NEVER in
// the request body, NEVER in the manifest, NEVER in the built bundle.
//
// Error mapping (spec "Malformed summary rejected" + UX states):
//   network       -> fetch rejected / offline / DNS      (retryable)
//   rate-limited  -> proxy returned 429                   (retry disabled briefly)
//   proxy-error   -> proxy returned non-2xx (5xx, 4xx)   (retryable)
//   malformed     -> 2xx body failed defensive parse      (not retryable)

import type { ProxyRequest, ProxyResponse, SummaryError } from './types';
import { parseProxyResponse } from './parseProxyResponse';

/** Deployed Vercel proxy host (matches manifest host_permissions). */
export const PROXY_BASE = 'https://ml-review-summary-proxy.vercel.app';
const ENDPOINT = `${PROXY_BASE}/api/summarize`;

/** Outcome: either a valid summary or a typed error (never throws). */
export type FetchSummaryResult = { ok: true; data: ProxyResponse } | { ok: false; error: SummaryError };

/**
 * Fetch a summary for `request` from the proxy. Accepts an optional `fetchImpl`
 * so tests can mock fetch without touching the network. Never throws — every
 * failure is returned as a typed SummaryError so the UI can render the right
 * state.
 */
export async function fetchSummary(
  request: ProxyRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchSummaryResult> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    return error('network', 'No se pudo conectar con el servicio de resumen.');
  }

  if (res.status === 429) {
    return error('rate-limited', 'Demasiadas solicitudes. Intentá de nuevo en unos segundos.');
  }
  if (!res.ok) {
    return error('proxy-error', `El servicio de resumen respondió ${res.status}.`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return error('malformed', 'La respuesta del proxy no contiene JSON.');
  }

  const parsed = parseProxyResponse(json);
  if (!parsed.ok) return parsed;
  return { ok: true, data: parsed.data };
}

function error(kind: SummaryError['kind'], message: string): { ok: false; error: SummaryError } {
  return { ok: false, error: { kind, message } };
}
