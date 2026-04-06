/**
 * =============================================================================
 * ORDER LIFECYCLE UTILITIES - DRY Shared Status Normalization
 * =============================================================================
 *
 * Fix F1 (F-6-1): Single source of truth for order/booking status normalization.
 * Previously duplicated in booking.routes.ts and order.routes.ts.
 *
 * Fix F6 (F-6-2): normalizeOrderStatus extracted for reuse.
 * =============================================================================
 */

/**
 * Normalize order lifecycle state for UI consumption.
 * Maps internal status values to simplified lifecycle states.
 *
 * @param status - Raw status string from database
 * @returns Normalized lifecycle state
 */
export function normalizeOrderLifecycleState(
  status: string | null | undefined
): 'active' | 'cancelled' | 'expired' | 'accepted' {
  if (!status) return 'active';
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'expired') return 'expired';
  if (normalized === 'fully_filled' || normalized === 'completed' || normalized === 'closed') return 'accepted';
  return 'active';
}

/**
 * Normalize raw order status string to lowercase.
 *
 * @param status - Raw status value (may be non-string)
 * @returns Lowercase status string, or empty string for non-string input
 */
export function normalizeOrderStatus(status: unknown): string {
  return typeof status === 'string' ? status.toLowerCase() : '';
}
