/**
 * =============================================================================
 * BROADCAST PAYLOAD NORMALIZER
 * =============================================================================
 *
 * Normalize any broadcast payload (legacy booking or canonical order) to a
 * consistent shape. Called before Socket.IO emit.
 *
 * FIX M-6: The booking path and order path produce different payload shapes.
 * This normalizer maps both into a single canonical form so the mobile app
 * receives a predictable structure regardless of which backend path created
 * the broadcast.
 *
 * Uses nullish coalescing (??) for numeric fields to avoid false-positive
 * fallbacks on 0 values for lat/lng.
 * =============================================================================
 */

export interface NormalizedBroadcastPayload {
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  pickupLocation: { lat: number; lng: number; address: string };
  dropoffLocation: { lat: number; lng: number; address: string };
  estimatedPrice: number;
  truckCount: number;
  createdAt: string;
  expiresAt: string;
}

/**
 * Normalize any broadcast payload (legacy booking or canonical order) to a
 * consistent shape. Called before Socket.IO emit.
 *
 * Uses nullish coalescing (??) for numeric fields to avoid false-positive
 * fallbacks on 0 values for lat/lng.
 */
export function normalizeBroadcastPayload(raw: Record<string, any>): NormalizedBroadcastPayload {
  return {
    orderId: raw.orderId ?? raw.bookingId ?? raw.id,
    vehicleType: raw.vehicleType ?? raw.vehicle_type ?? raw.truckType ?? '',
    vehicleSubtype: raw.vehicleSubtype ?? raw.vehicle_subtype ?? 'standard',
    pickupLocation: {
      lat: raw.pickupLocation?.latitude ?? raw.pickup?.latitude ?? 0,
      lng: raw.pickupLocation?.longitude ?? raw.pickup?.longitude ?? 0,
      address: raw.pickupLocation?.address ?? raw.pickup?.address ?? '',
    },
    dropoffLocation: {
      lat: raw.dropLocation?.latitude ?? raw.drop?.latitude ?? 0,
      lng: raw.dropLocation?.longitude ?? raw.drop?.longitude ?? 0,
      address: raw.dropLocation?.address ?? raw.drop?.address ?? '',
    },
    estimatedPrice: raw.pricePerTruck ?? raw.farePerTruck ?? raw.estimatedPrice ?? 0,
    truckCount: raw.trucksNeeded ?? raw.trucksNeededOfThisType ?? 1,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    expiresAt: raw.expiresAt ?? '',
  };
}
