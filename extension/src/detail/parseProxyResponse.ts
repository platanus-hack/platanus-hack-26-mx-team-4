// Defensive proxy-response parser (Pilar 2).
//
// The Vercel proxy enforces the ProxyResponse shape via Gemini's
// responseSchema, but the extension NEVER trusts the wire blindly (spec:
// "The extension MUST defensively handle malformed JSON or schema mismatch").
// This module is the single source of truth for "is this a valid summary?" and
// is reused by the cache (to guard stored entries) and the proxy client (to
// validate fetch results). It NEVER crashes: a bad payload yields a typed
// SummaryError, not a throw.

import type { ProxyResponse, SummaryError } from './types';

/** Outcome of a defensive parse: either a valid summary or a typed error. */
export type ParseResult = { ok: true; data: ProxyResponse } | { ok: false; error: SummaryError };

/** Structural guard: three string arrays + a non-empty string verdict. */
export function isProxyResponse(value: unknown): value is ProxyResponse {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.strongPoints) &&
    r.strongPoints.every((s) => typeof s === 'string') &&
    Array.isArray(r.weakPoints) &&
    r.weakPoints.every((s) => typeof s === 'string') &&
    typeof r.verdict === 'string' &&
    r.verdict.trim().length > 0
  );
}

/**
 * Defensively parse a proxy payload into a ProxyResponse, or a typed
 * SummaryError. Tolerates a raw JSON string (parses it first), and tolerates
 * arrays that contain a few non-string items by keeping only the strings
 * (drops garbage instead of rejecting the whole summary). A missing/empty
 * verdict is rejected (the verdict is the headline of the card).
 */
export function parseProxyResponse(value: unknown): ParseResult {
  let payload = value;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return malformed('La respuesta del proxy no es JSON válido.');
    }
  }

  if (typeof payload !== 'object' || payload === null) {
    return malformed('La respuesta del proxy no es un objeto.');
  }

  const r = payload as Record<string, unknown>;
  // Sections MUST be present arrays (a missing section is a schema violation ->
  // malformed/incomplete). Non-string ITEMS inside an array are tolerated by
  // filtering (drop garbage instead of rejecting the whole summary).
  if (!Array.isArray(r.strongPoints)) {
    return malformed('La respuesta del proxy no incluye "strongPoints".');
  }
  if (!Array.isArray(r.weakPoints)) {
    return malformed('La respuesta del proxy no incluye "weakPoints".');
  }
  const strongPoints = r.strongPoints.filter((s): s is string => typeof s === 'string');
  const weakPoints = r.weakPoints.filter((s): s is string => typeof s === 'string');
  const verdict = typeof r.verdict === 'string' ? r.verdict.trim() : '';

  if (verdict.length === 0) {
    return malformed('La respuesta del proxy no incluye un veredicto.');
  }

  return { ok: true, data: { strongPoints, weakPoints, verdict } };
}

function malformed(message: string): { ok: false; error: SummaryError } {
  return { ok: false, error: { kind: 'malformed', message } };
}
