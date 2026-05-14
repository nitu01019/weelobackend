/**
 * =============================================================================
 * ERROR LOG META — toLogMeta() error-fingerprint serializer (Fix #19, Phase 6)
 * =============================================================================
 *
 * Single source of truth for {errorCode, errorClass, errorMessage,
 * errorCategory} log-meta shape across the codebase. Centralising the
 * AppError / Error / unknown trichotomy here:
 *
 *   1. Fixes the `error.constructor.name` crash on `throw 'oops'` (primitive
 *      throws have no `.constructor.name`).
 *   2. Eliminates errorcode / errorCode typo opportunities at ~1,500 emit
 *      sites — fingerprint shape is stable across CloudWatch metric filters.
 *   3. Provides CWE-532 defense-in-depth — error.message text and any
 *      stringified non-Error throw is pattern-redacted before CloudWatch
 *      ingestion (phone, email, JWT-ish base64 tokens).
 *
 * The validated Fix #19 Solution at index-30-validated.md L4936-5248 imports
 * `redactSensitivePatterns` from `logger.service.ts`. At HEAD a0e90fd3 that
 * symbol does not exist (it lives on a divergent branch chain that never
 * merged into Phase 1-5). To stay strictly in the Fix #19 lane and avoid
 * touching logger.service.ts (Fix #18's adjacent file), the redactor is
 * inlined here as `redactErrorMessage`. When/if the upstream PII work lands,
 * this can be reduced to a 1-line import swap.
 *
 * Stack is deliberately NOT folded into toLogMeta — it can be large and
 * PII-laden; callers decide whether to include it (and run it through
 * redactErrorMessage themselves). SRP.
 * =============================================================================
 */

import { AppError } from '../types/error.types';
import { getErrorCategory, ErrorCode } from '../../core/constants';

export interface ErrorLogMeta {
  errorCode: string;
  errorClass: string;
  errorMessage: string;
  errorCategory: string;
}

/**
 * Defense-in-depth string redactor for error messages and stack frames.
 * Replaces phone-shaped digit runs (Indian 10-digit + international `+CC…`),
 * email tokens (RFC 5322 simplified), and JWT-shaped 3-part base64url tokens
 * with `[REDACTED_*]` placeholders. Used as a thin wrapper around
 * `error.message` / `String(error)` before the value lands in a CloudWatch
 * log line.
 *
 * Card-like digit redaction is NOT implemented here — the false-positive
 * rate on order IDs / truck registration numbers / batch IDs would corrupt
 * debugging signal more than it would protect. Card/PAN data does not flow
 * through Weelo's error path today (payments are Razorpay-hosted; no PAN
 * touches our servers).
 *
 * Patterns intentionally conservative — false-negatives are acceptable
 * (key-based redaction in logger.service.ts catches structured fields);
 * false-positives in error messages are not (we must not corrupt a useful
 * error message past the point of debugging).
 */
export function redactErrorMessage(msg: string): string {
  if (typeof msg !== 'string' || msg.length === 0) return msg;
  let result = msg;
  // Email: word@word.tld (RFC 5322 simplified).
  result = result.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '[REDACTED_EMAIL]',
  );
  // International phone: +<country><digits>, 8-15 total digits.
  result = result.replace(/\+\d{1,4}[\s-]?\d{6,12}/g, '[REDACTED_PHONE]');
  // Indian-shaped 10-digit phone (6-9 lead, 9 more digits), word-boundary anchored.
  result = result.replace(/\b[6-9]\d{9}\b/g, '[REDACTED_PHONE]');
  // JWT-shaped token: 3 dot-separated base64url chunks, each ≥10 chars.
  result = result.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    '[REDACTED_JWT]',
  );
  return result;
}

/**
 * Convert any thrown value into a stable CloudWatch-filterable log-meta
 * object. Guaranteed to return all four ErrorLogMeta fields as strings,
 * never crashes on primitive throws, never throws itself.
 *
 *   toLogMeta(new AppError(403, 'AUTH_1002', 'expired'))
 *   // → { errorCode: 'AUTH_1002', errorClass: 'AppError',
 *   //     errorMessage: 'expired', errorCategory: 'authentication' }
 *
 *   toLogMeta(new Error('boom'))
 *   // → { errorCode: 'INTERNAL_ERROR', errorClass: 'Error',
 *   //     errorMessage: 'boom', errorCategory: 'system' }
 *
 *   toLogMeta('oops')
 *   // → { errorCode: 'INTERNAL_ERROR', errorClass: 'UnknownError',
 *   //     errorMessage: 'oops', errorCategory: 'system' }
 */
export function toLogMeta(error: unknown): ErrorLogMeta {
  if (error instanceof AppError) {
    const code = error.code || 'INTERNAL_ERROR';
    return {
      errorCode: code,
      errorClass: error.constructor.name,
      errorMessage: redactErrorMessage(error.message ?? ''),
      errorCategory: deriveCategory(code),
    };
  }
  if (error instanceof Error) {
    return {
      errorCode: 'INTERNAL_ERROR',
      errorClass: error.constructor.name,
      errorMessage: redactErrorMessage(error.message ?? ''),
      errorCategory: deriveCategory('INTERNAL_ERROR'),
    };
  }
  // Non-Error throws (string, number, null, undefined, plain object,
  // Object.create(null) — String() throws on the last; wrap defensively.
  let stringified: string;
  try {
    stringified = String(error ?? '');
  } catch {
    stringified = '[UnstringifiableError]';
  }
  return {
    errorCode: 'INTERNAL_ERROR',
    errorClass: 'UnknownError',
    errorMessage: redactErrorMessage(stringified),
    errorCategory: deriveCategory('INTERNAL_ERROR'),
  };
}

/**
 * Reuse the prefix-aware helper from core/constants. ERROR_CATEGORY_MAP keys
 * are prefixes-with-trailing-`_` (`AUTH_`, `VAL_`, `SYS_`, etc.) so a direct
 * lookup keyed on the full code `'AUTH_1002'` always misses; getErrorCategory
 * does the split. Wrapped in try/catch because the `code as ErrorCode` cast
 * accepts arbitrary strings (AppError.code is `readonly string`, not the
 * `ErrorCode` enum), so a malformed `code` like `''` falls through to the
 * heuristic instead of throwing.
 */
function deriveCategory(code: string): string {
  try {
    return getErrorCategory(code as ErrorCode);
  } catch {
    const prefix = code.split('_')[0];
    return prefix && prefix.length > 0 ? prefix : 'system';
  }
}
