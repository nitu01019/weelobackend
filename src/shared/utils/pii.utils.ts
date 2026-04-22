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
