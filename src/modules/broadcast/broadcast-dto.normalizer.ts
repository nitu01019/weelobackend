/**
 * F-L21: Broadcast DTO Normalizer
 * Unified broadcast shape for both polling and socket emission.
 * Backward-compatible — Captain app fallbacks preserved.
 */

export interface NormalizedBroadcast {
  // Primary identifiers (both names for backward compat)
  broadcastId: string;
  orderId: string;  // Alias for broadcastId
  bookingId: string; // Alias for broadcastId

  // Core fields
  status: string;
  vehicleType: string;
  vehicleSubtype?: string;
  trucksNeeded: number;
  trucksFilled: number;

  // Location
  pickup: Record<string, unknown>;
  drop: Record<string, unknown>;
  distanceKm: number;

  // Pricing
  pricePerTruck: number;
  totalAmount?: number;

  // Metadata
  customerName: string;
  expiresAt: string;
  createdAt: string;

  // Normalization marker
  _normalized: true;
}

export function normalizeBroadcast(raw: Record<string, unknown>): NormalizedBroadcast {
  const id = String(raw.id || raw.broadcastId || raw.orderId || raw.bookingId || '');
  return {
    broadcastId: id,
    orderId: id,
    bookingId: id,
    status: String(raw.status || 'unknown'),
    vehicleType: String(raw.vehicleType || ''),
    vehicleSubtype: raw.vehicleSubtype ? String(raw.vehicleSubtype) : undefined,
    trucksNeeded: Number(raw.trucksNeeded || 1),
    trucksFilled: Number(raw.trucksFilled || 0),
    pickup: (raw.pickup || {}) as Record<string, unknown>,
    drop: (raw.drop || {}) as Record<string, unknown>,
    distanceKm: Number(raw.distanceKm || 0),
    pricePerTruck: Number(raw.pricePerTruck || raw.farePerTruck || 0),
    totalAmount: raw.totalAmount ? Number(raw.totalAmount) : undefined,
    customerName: String(raw.customerName || ''),
    expiresAt: String(raw.expiresAt || ''),
    createdAt: String(raw.createdAt || ''),
    _normalized: true,
  };
}

export function normalizeBroadcasts(raws: Record<string, unknown>[]): NormalizedBroadcast[] {
  return raws.map(normalizeBroadcast);
}
