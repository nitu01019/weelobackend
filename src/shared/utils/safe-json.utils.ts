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
 * Logs a warning on parse failure so data corruption is visible in CloudWatch.
 *
 * @param value - The string to parse (may be null or undefined)
 * @param fallback - The value to return when parsing fails or value is nullish
 * @param context - Optional context label for log tracing (e.g. 'fleet-cache', 'order.pickup')
 * @returns The parsed value or the fallback
 */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T, context?: string): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    // Log parse failures so data corruption (e.g. [object Object] in Redis) is detectable
    const { logger } = require('../services/logger.service');
    logger.warn('[safeJsonParse] Parse failed', {
      context: context || 'unknown',
      snippet: value.length > 80 ? value.slice(0, 80) + '…' : value
    });
    return fallback;
  }
}
