/**
 * =============================================================================
 * ERROR UTILITIES
 * =============================================================================
 *
 * Safe helpers for extracting information from `unknown` catch-block values.
 * Replaces all `(error as any).message` patterns with type-safe alternatives.
 * =============================================================================
 */

/**
 * Safely extract error message from unknown catch block value.
 * Replaces all (error as any).message patterns.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Safely extract error for logging (message + stack if available).
 */
export function getErrorForLog(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
