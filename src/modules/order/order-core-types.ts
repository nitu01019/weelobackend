/**
 * =============================================================================
 * ORDER CORE TYPES - Public type definitions exported from order.service.ts
 * =============================================================================
 *
 * Extracted from order.service.ts during file-size decomposition.
 * Contains all publicly-exported types and shared constants.
 * =============================================================================
 */

// =============================================================================
// CACHE KEYS & TTL (Optimized for fast lookups)
// =============================================================================
export const CACHE_KEYS = {
  ORDER: 'order:',
  ACTIVE_REQUESTS: 'active:requests:'
};

export const CACHE_TTL = {
  ORDER: 60,            // 1 minute - order details
  ACTIVE_REQUESTS: 30   // 30 seconds - active requests list
};

export const FF_DB_STRICT_IDEMPOTENCY = process.env.FF_DB_STRICT_IDEMPOTENCY !== 'false';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Vehicle requirement in a booking
 * Customer can request multiple types in one booking
 */
export interface VehicleRequirement {
  vehicleType: string;      // e.g., "tipper", "container", "open"
  vehicleSubtype: string;   // e.g., "20-24 Ton", "17ft"
  quantity: number;         // How many trucks of this type
  pricePerTruck: number;    // Price for this specific type
}

/**
 * Route Point for intermediate stops
 *
 * IMPORTANT: Stops are defined BEFORE booking only!
 * After booking: NO adding, removing, or reordering
 */
export interface RoutePointInput {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
}

/**
 * Create order request from customer app
 *
 * ROUTE POINTS:
 * - Option 1: Full route with stops (routePoints array)
 * - Option 2: Simple pickup/drop (legacy, backward compatible)
 *
 * If routePoints is provided, pickup/drop are extracted from first/last points
 */
export interface CreateOrderRequest {
  customerId: string;
  customerName: string;
  customerPhone: string;

  // Option 1: Full route with intermediate stops (NEW - preferred)
  routePoints?: RoutePointInput[];

  // Option 2: Simple pickup/drop (LEGACY - backward compatible)
  pickup?: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  drop?: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };

  distanceKm: number;

  // Multiple vehicle types
  vehicleRequirements: VehicleRequirement[];

  // Optional
  goodsType?: string;
  cargoWeightKg?: number;
  scheduledAt?: string;  // For scheduled bookings

  // SCALABILITY: Idempotency key prevents duplicate orders on network retry
  idempotencyKey?: string;  // UUID from client (optional)
}

/**
 * Response after creating order
 */
export interface CreateOrderResponse {
  orderId: string;
  totalTrucks: number;
  totalAmount: number;
  dispatchState: 'queued' | 'dispatching' | 'dispatched' | 'dispatch_failed';
  dispatchAttempts: number;
  onlineCandidates: number;
  notifiedTransporters: number;
  reasonCode?: string;
  serverTimeMs: number;
  truckRequests: {
    id: string;
    vehicleType: string;
    vehicleSubtype: string;
    quantity: number;
    pricePerTruck: number;
    matchingTransporters: number;
  }[];
  expiresAt: string;
  expiresIn: number;  // SCALABILITY: Duration in seconds - UI uses this for countdown timer
}
