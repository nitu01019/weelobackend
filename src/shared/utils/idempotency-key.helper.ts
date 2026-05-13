// src/shared/utils/idempotency-key.helper.ts
//
// Single source of truth for reading the client-supplied idempotency key from
// an Express request. Accepts BOTH the IETF-canonical bare header
// (`Idempotency-Key`, draft-ietf-httpapi-idempotency-key-header-07 §2) and the
// legacy X-prefixed header (`X-Idempotency-Key`, retained for deployed Weelo
// mobile clients per RFC 6648 "preserve existing deployments").
//
// Defends against:
//   • RFC 7230 §3.2.2 duplicate-header concatenation (Node delivers comma-joined value).
//   • RFC 7540 §8.1.2.5 HTTP/2 multi-value array form.
//   • IETF draft-07 §2 charset: 1*256 VCHAR — rejects emoji, NUL, lone surrogates,
//     embedded spaces, DEL (0x7F), any non-printable that would poison Redis keys.
//
// SECURITY: Caller MUST construct cache keys that include the authenticated
// principal (userId / transporterId / driverId) AND resource subject (orderId /
// holdId / broadcastId) to prevent cross-user replay. Pattern:
//   `idempotency:<scope>:<principal>:<subject>:${readIdempotencyKey(req)}`
//
// Route handlers MUST NOT call `req.header('X-Idempotency-Key')` or
// `req.headers['x-idempotency-key']` directly — those patterns are banned by
// the ESLint rule `no-restricted-syntax` in `.eslintrc.eslint-rules.json`.

import type { Request, Response } from 'express';

/** IETF draft-07 §2: 1*256 VCHAR. */
const MAX_KEY_LEN = 255;
const VCHAR_RE = /^[\x21-\x7E]+$/;

function readSingle(name: string, req: Request): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- only legitimate raw read in repo
  const raw = req.headers[name.toLowerCase()];

  // HTTP/2 multi-value (RFC 7540 §8.1.2.5) — refuse rather than guess.
  if (typeof raw !== 'string') return undefined;

  // RFC 7230 §3.2.2 — comma-joined dup-header. No legitimate idempotency token
  // (UUID-v4, ULID, base64url, hex) contains a comma. Refuse the ambiguity.
  if (raw.includes(',')) return undefined;

  const trimmed = raw.trim();

  // Length: blank or > IETF cap.
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LEN) return undefined;

  // IETF draft-07 §2 VCHAR (0x21-0x7E). Rejects emoji (surrogate pairs),
  // NUL, lone surrogates, DEL (0x7F), embedded spaces.
  if (!VCHAR_RE.test(trimmed)) return undefined;

  return trimmed;
}

/**
 * Read the client-supplied idempotency key, preferring the IETF bare header
 * and falling back to the legacy X-prefixed header.
 *
 * Returns `undefined` when neither header is present, when the value fails
 * IETF charset/length validation, or when an RFC 7230 §3.2.2 duplicate-header
 * concatenation is detected.
 *
 * Precedence: bare wins when both are sent (forward-compat with IETF migration).
 */
export function readIdempotencyKey(req: Request): string | undefined {
  return readSingle('Idempotency-Key', req) ?? readSingle('X-Idempotency-Key', req);
}

/**
 * Echo the idempotency key in BOTH canonical and legacy header slots on the
 * response. Used by handlers that server-generate keys (truck-hold, broadcast).
 */
export function echoIdempotencyKey(res: Response, key: string): void {
  res.setHeader('Idempotency-Key', key);
  res.setHeader('X-Idempotency-Key', key); // legacy alias — keep until mobile EOL
}
