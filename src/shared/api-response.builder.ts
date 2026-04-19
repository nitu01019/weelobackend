/**
 * F-M7: Unified API Response Builders
 * Provides typed builders for consistent response shapes across booking/order/broadcast paths.
 * Uses superset approach for backward compatibility.
 */

export interface AcceptResponseData {
  assignmentId: string;
  tripId: string;
  status: string;
  resultCode?: string;
  replayed?: boolean;
  trucksConfirmed?: number;
  totalTrucksNeeded?: number;
  isFullyFilled?: boolean;
  _responseVersion: 2;
}

export function buildAcceptResponse(params: {
  assignmentId: string;
  tripId: string;
  status: string;
  resultCode?: string;
  replayed?: boolean;
  trucksConfirmed?: number;
  totalTrucksNeeded?: number;
  isFullyFilled?: boolean;
}): { success: true; data: AcceptResponseData; message: string } {
  return {
    success: true,
    message: 'Assignment accepted successfully',
    data: {
      ...params,
      _responseVersion: 2,
    },
  };
}

export interface BookingCreateResponseData {
  bookingId: string;
  orderId?: string;
  status: string;
  trucksNeeded: number;
  expiresAt: string;
  _responseVersion: 2;
}

export function buildBookingCreateResponse(params: {
  bookingId: string;
  orderId?: string;
  status: string;
  trucksNeeded: number;
  expiresAt: string;
}): { success: true; data: BookingCreateResponseData } {
  return {
    success: true,
    data: { ...params, _responseVersion: 2 },
  };
}

export interface CancelResponseData {
  cancelled: boolean;
  bookingId?: string;
  orderId?: string;
  status: string;
  refundEligible?: boolean;
  _responseVersion: 2;
}

export function buildCancelResponse(params: {
  cancelled: boolean;
  bookingId?: string;
  orderId?: string;
  status: string;
  refundEligible?: boolean;
}): { success: true; data: CancelResponseData } {
  return {
    success: true,
    data: { ...params, _responseVersion: 2 },
  };
}
