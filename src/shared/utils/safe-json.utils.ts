/**
 * =============================================================================
 * SAFE JSON UTILITIES
 * =============================================================================
 *
 * Safely parse JSON from external sources (Redis, APIs, etc.) with a fallback.
 * Prevents uncaught SyntaxError crashes from corrupted or unexpected data.
 * =============================================================================
 */

/**
 * Safely parse a JSON string, returning a fallback on null/undefined/invalid input.
 *
 * @param value - The string to parse (may be null or undefined)
 * @param fallback - The value to return when parsing fails or value is nullish
 * @returns The parsed value or the fallback
 */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
