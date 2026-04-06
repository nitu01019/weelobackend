/**
 * =============================================================================
 * RESPONSE BUILDERS - DRY Shared Response Formatting
 * =============================================================================
 *
 * Fix F3 (F-6-15): Single source of truth for cancel response building.
 * Previously duplicated in booking.routes.ts and order.routes.ts.
 *
 * Fix F4 (F-6-16): Shared broadcast snapshot response builder.
 * =============================================================================
 */

/**
 * Build a standardized cancel response from a cancellation result.
 *
 * @param cancellation - The cancellation result object from the service layer
 * @returns Formatted cancel response for API consumers
 */
export function buildCancelResponse(cancellation: {
  orderId?: string;
  bookingId?: string;
  reason?: string;
  policyStage?: string;
  cancelDecision?: string;
  cancelledAt?: string | Date;
  [key: string]: unknown;
}): object {
  return {
    success: true,
    data: {
      orderId: cancellation.orderId || cancellation.bookingId,
      status: 'cancelled',
      reason: cancellation.reason,
      policyStage: cancellation.policyStage,
      cancelDecision: cancellation.cancelDecision,
      cancelledAt: cancellation.cancelledAt,
    }
  };
}

/**
 * Build a standardized broadcast snapshot response.
 * Used by both booking.routes.ts and order.routes.ts broadcast-snapshot endpoints.
 *
 * @param snapshot - The broadcast snapshot data from the service layer
 * @param meta - Additional metadata (role, orderId, etc.)
 * @returns Formatted broadcast snapshot response
 */
export function buildBroadcastSnapshotResponse(
  snapshot: {
    broadcasts?: unknown[];
    total?: number;
    [key: string]: unknown;
  },
  meta?: {
    orderId?: string;
    role?: string;
  }
): object {
  return {
    success: true,
    data: {
      ...snapshot,
      ...(meta?.orderId ? { orderId: meta.orderId } : {}),
      ...(meta?.role ? { requestedBy: meta.role } : {}),
    }
  };
}
