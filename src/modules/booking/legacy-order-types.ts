/**
 * @deprecated Legacy booking order types. See order.service.ts deprecation notice.
 *
 * Shared configuration, Redis key patterns, and type definitions
 * used across all legacy-order-* sub-modules.
 */

import { OrderRecord, TruckRequestRecord } from '../../shared/database/db';

// =============================================================================
// CONFIGURATION
// =============================================================================

const BROADCAST_TIMEOUT_SECONDS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10);

export const ORDER_CONFIG = {
  // Timeout: env-configurable, default 120s. Unified with booking path.
  TIMEOUT_MS: BROADCAST_TIMEOUT_SECONDS * 1000,

  // How often to check for expired orders (Redis-based)
  EXPIRY_CHECK_INTERVAL_MS: 5 * 1000,  // Every 5 seconds
};

// =============================================================================
// REDIS KEY PATTERNS (for distributed timers)
// =============================================================================
//
// SCALABILITY: Redis keys are shared across all ECS instances
// EASY UNDERSTANDING: Clear naming convention -- timer:booking-order:{orderId}
// MODULARITY: Separate prefix from booking.service.ts timers (timer:booking:)
// =============================================================================
export const TIMER_KEYS = {
  ORDER_EXPIRY: (orderId: string) => `timer:booking-order:${orderId}`,
};

// =============================================================================
// TYPES
// =============================================================================

export interface OrderTimerData {
  orderId: string;
  customerId: string;
  createdAt: string;
}

export interface GroupedRequests {
  vehicleType: string;
  vehicleSubtype: string;
  requests: TruckRequestRecord[];
  transporterIds: string[];
}

export interface CreateOrderResult {
  order: OrderRecord;
  truckRequests: TruckRequestRecord[];
  broadcastSummary: {
    totalRequests: number;
    groupedBy: { vehicleType: string; vehicleSubtype: string; count: number; transportersNotified: number }[];
    totalTransportersNotified: number;
  };
  timeoutSeconds: number;
}
