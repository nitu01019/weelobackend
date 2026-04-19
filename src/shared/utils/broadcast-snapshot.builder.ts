/**
 * =============================================================================
 * BROADCAST SNAPSHOT BUILDER - DRY Shared Snapshot Response
 * =============================================================================
 *
 * Fix F4 (F-6-16): Single source of truth for broadcast snapshot responses.
 * Previously duplicated in booking.routes.ts and order.routes.ts.
 *
 * =============================================================================
 */

interface BroadcastSnapshotInput {
  orderId?: string;
  bookingId?: string;
  status?: string;
  trucksNeeded?: number;
  trucksFilled?: number;
  expiresAt?: string | Date;
  assignments?: unknown[];
  notifiedTransporters?: string[];
  [key: string]: unknown;
}

/**
 * Build a standardized broadcast snapshot response.
 *
 * @param data - Raw snapshot data from the service layer
 * @param role - Role of the requesting user
 * @returns Formatted broadcast snapshot response
 */
export function buildBroadcastSnapshotResponse(
  data: BroadcastSnapshotInput,
  role?: string
): object {
  return {
    success: true,
    data: {
      orderId: data.orderId || data.bookingId,
      status: data.status,
      trucksNeeded: data.trucksNeeded,
      trucksFilled: data.trucksFilled,
      expiresAt: data.expiresAt,
      assignments: data.assignments || [],
      notifiedCount: data.notifiedTransporters?.length || 0,
      ...(role ? { requestedBy: role } : {}),
    }
  };
}
