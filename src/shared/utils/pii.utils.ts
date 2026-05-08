/**
 * PII Masking Utilities
 *
 * Masks personally identifiable information (phone numbers) for
 * external-facing payloads and log output.
 *
 * DPDP Act 2023 §5(b) — data minimisation: PII fields must never appear
 * raw in log output. Use maskPhoneForLog / maskPhoneForLogSafe for log
 * context, and keep PII in structured meta only (never in template literals).
 */

/**
 * Canonical list of PII field names (A12-003/004/005/006 — DPDP §5(b)).
 * Single source of truth imported by logger.service.ts and any other
 * module that needs to scrub structured metadata.
 */
export const SENSITIVE_FIELDS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'authorization',
  'otp',
  'pin',
  'phone',
  'name',
  'customerName',
  'driverName',
  'customerPhone',
  'driverPhone',
] as const;

/**
 * Mask phone number for external-facing payloads.
 * Returns '******XXXX' format (last 4 visible).
 * Returns '' for null/undefined (backward-compatible).
 */
export function maskPhoneForExternal(phone: string | null | undefined): string {
  if (!phone) return '';
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length < 4) return '****';
  return '******' + cleaned.slice(-4);
}

/**
 * Mask phone for logging purposes.
 * Returns '' for null/undefined (delegates to maskPhoneForExternal).
 * Use maskPhoneForLogSafe when 'unknown' is preferred over empty string.
 */
export function maskPhoneForLog(phone: string | null | undefined): string {
  return maskPhoneForExternal(phone);
}

/**
 * Mask phone for logging — returns 'unknown' for null/undefined.
 * Preferred over maskPhoneForLog when the empty-string ambiguity is
 * problematic (e.g. structured JSON log fields).
 */
export function maskPhoneForLogSafe(phone: string | null | undefined): string {
  if (phone == null) return 'unknown';
  return maskPhoneForExternal(phone);
}

/**
 * Return the last 4 digits of a phone number for structured log meta.
 * Use as: logger.info('event', { phoneLast4: phoneLast4(p) })
 * — never as part of a template literal message body.
 *
 * Returns '' for null/undefined and short strings (<4 digits).
 */
export function phoneLast4(phone: string | null | undefined): string {
  if (!phone) return '';
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length < 4) return '';
  return cleaned.slice(-4);
}

// =============================================================================
// NAME MASKING (P0-1 / V11-NEW-06, V11-NEW-07, V6-NEW-01)
// =============================================================================
// Promoted from rating.service.ts:396-400 to be the single source of truth
// for customerName / driverName masking across the backend. DPDP §8(3): names
// must not appear raw in customer-facing or driver-facing emits, FCM data
// extras, or socket payloads. Use this helper at every producer site.
//
// Examples:
//   maskName('Amit Kumar') → 'A***r'
//   maskName('A')          → 'A***'
//   maskName('')           → 'Customer'
//   maskName(null)         → 'Customer'
// =============================================================================

/**
 * Mask a person's name for external-facing payloads (DPDP §8(3)).
 *
 * - first character + '***' + last character when length >= 2
 * - first character + '***' when length === 1
 * - 'Customer' when null / undefined / empty
 *
 * Behaviour intentionally identical to the rating.service.ts:396-400 origin
 * so existing emits continue to render the same masked value.
 */
export function maskName(name: string | null | undefined): string {
  if (!name || name.length === 0) return 'Customer';
  if (name.length <= 2) return name[0] + '***';
  return name[0] + '***' + name[name.length - 1];
}

// =============================================================================
// PHONE HASHING FOR REDIS KEYS (P0-2 / V11-NEW-09)
// =============================================================================
// hashPhoneForKey replaces raw phone numbers in Redis keys (rate-limit
// buckets, dedup sets, etc.). DPDP §8(3) — PII must not appear in cache
// keys; an attacker with Redis read access could enumerate user phones via
// SCAN MATCH 'rate:phone:*'.
//
// Output: SHA-256(phone || PHONE_KEY_SALT) truncated to 16 hex chars.
// Collision probability at 10^9 phones is ~3.5e-11 — acceptable for keys
// scoped to a per-route rate-limit bucket.
//
// PHONE_KEY_SALT is validated at boot (length ≥ 32) — see environment.ts.
// =============================================================================

import { createHash } from 'crypto';

const PHONE_KEY_HASH_LENGTH = 16;

/**
 * Lazily resolve PHONE_KEY_SALT at first call (not at module load) so unit
 * tests can mutate process.env before invoking the helper.
 */
function resolvePhoneKeySalt(): string {
  const salt = process.env.PHONE_KEY_SALT;
  if (!salt || salt.length < 32) {
    throw new Error(
      'PHONE_KEY_SALT must be set and at least 32 characters before hashPhoneForKey is called. ' +
      'Boot validation in environment.ts should have prevented this state.'
    );
  }
  return salt;
}

/**
 * Normalize an Indian phone number to a 10-digit canonical form before
 * hashing/keying. Accepts the four formats users commonly type:
 *   - '+919876543210'  (E.164)
 *   - '919876543210'   (no plus, 12-digit)
 *   - '09876543210'    (legacy STD prefix, 11-digit)
 *   - '9876543210'     (10-digit national)
 *
 * INDIA-ONLY: this helper assumes the input is an Indian mobile number.
 * Non-Indian / unrecognised lengths pass through as digits-only so
 * downstream hashing remains deterministic — it is safer to "over-hash"
 * (different keys for different inputs we cannot canonicalize) than to
 * "under-canonicalize" (collapse two distinct foreign numbers into one).
 *
 * Examples (all return '9876543210'):
 *   canonicalizeIndianPhone('+91 98765 43210') === '9876543210'
 *   canonicalizeIndianPhone('919876543210')    === '9876543210'
 *   canonicalizeIndianPhone('09876543210')     === '9876543210'
 *   canonicalizeIndianPhone('9876543210')      === '9876543210'
 *
 * Pass-through (non-Indian, unrecognised length):
 *   canonicalizeIndianPhone('+1234567890123')  === '1234567890123'
 */
export function canonicalizeIndianPhone(phone: string): string {
  const digits = String(phone).replace(/\D/g, '');
  // Strip leading 91 country code (12-digit India E.164 without plus)
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  // Strip legacy leading 0 STD prefix (11-digit India national)
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1);
  return digits;
}

/**
 * Hash a phone number for use in Redis keys (V11-NEW-09).
 *
 * @param phone — raw phone number; non-digits are stripped AND the Indian
 *   country code / leading-zero variants are canonicalized before hashing.
 *   This means '+919876543210', '919876543210', '09876543210' and
 *   '9876543210' all produce the SAME key (DPDP §8(3) + rate-limit /
 *   OTP-dedup correctness — see C10 in dpdp-pii-leakage.test.ts).
 * @returns 16-char hex digest of SHA-256(canonical || salt). Throws if phone
 *   is empty/undefined OR if PHONE_KEY_SALT is missing/too short.
 */
export function hashPhoneForKey(phone: string | null | undefined): string {
  if (!phone) {
    throw new Error('hashPhoneForKey: phone is required');
  }
  const canonical = canonicalizeIndianPhone(String(phone));
  if (canonical.length === 0) {
    throw new Error('hashPhoneForKey: phone contained no digits');
  }
  const salt = resolvePhoneKeySalt();
  return createHash('sha256')
    .update(canonical + salt)
    .digest('hex')
    .slice(0, PHONE_KEY_HASH_LENGTH);
}
