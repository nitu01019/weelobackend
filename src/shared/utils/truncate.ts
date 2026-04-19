/**
 * Truncate a string to maxLen, appending suffix only when the string
 * actually exceeds the limit.  Returns '' for null/undefined input.
 *
 * Fix #128 — replaces unconditional `str.substring(0, N) + '...'` patterns
 * that added ellipsis even when the string was already short.
 */
export function truncate(str: string, maxLen: number, suffix = '...'): string {
  if (!str || str.length <= maxLen) return str || '';
  return str.substring(0, maxLen - suffix.length) + suffix;
}
