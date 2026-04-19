/**
 * PII Masking Utilities
 *
 * Masks personally identifiable information (phone numbers) for
 * external-facing payloads and log output.
 */

/**
 * Mask phone number for external-facing payloads.
 * Returns '******XXXX' format (last 4 visible).
 */
export function maskPhoneForExternal(phone: string | null | undefined): string {
  if (!phone) return '';
  const cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length < 4) return '****';
  return '******' + cleaned.slice(-4);
}

/**
 * Mask phone for logging purposes.
 * Same as maskPhoneForExternal but with explicit naming.
 */
export function maskPhoneForLog(phone: string | null | undefined): string {
  return maskPhoneForExternal(phone);
}
