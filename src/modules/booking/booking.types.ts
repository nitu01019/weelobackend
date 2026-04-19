/**
 * =============================================================================
 * BOOKING MODULE - SHARED TYPES & CONFIGURATION
 * =============================================================================
 *
 * Shared types, interfaces, and configuration constants used across all
 * booking sub-services.
 * =============================================================================
 */

import { PROGRESSIVE_RADIUS_STEPS } from '../order/progressive-radius-matcher';

// =============================================================================
// CONFIGURATION - Easy to adjust for testing vs production
// =============================================================================

const BROADCAST_TIMEOUT_SECONDS = parseInt(process.env.BROADCAST_TIMEOUT_SECONDS || '120', 10);

export const BOOKING_CONFIG = {
  // Timeout: env-configurable, default 120s. Must be > progressive radius time (4 × 15s = 60s)
  TIMEOUT_MS: BROADCAST_TIMEOUT_SECONDS * 1000,

  // How often to check for expired bookings (Redis-based)
  EXPIRY_CHECK_INTERVAL_MS: 5 * 1000,  // Every 5 seconds
};

// =============================================================================
// PROGRESSIVE RADIUS EXPANSION CONFIG (Requirement 6)
// =============================================================================
// Fix H-X2: Unified config — imports steps from progressive-radius-matcher.ts
// Both booking path and order path now share the same 6-step radius steps.
// Total time: 10+10+15+15+15+15 = 80s < 108s (passes startup validation)
// =============================================================================
export const RADIUS_EXPANSION_CONFIG = {
  steps: PROGRESSIVE_RADIUS_STEPS.map(step => ({
    radiusKm: step.radiusKm,
    timeoutMs: step.windowMs,
  })),
  // FIX #58: Env-configurable instead of hardcoded
  // FIX #26: NaN guard + floor of 1 prevents 0 from returning no candidates
  maxTransportersPerStep: (() => { const r = parseInt(process.env.MAX_TRANSPORTERS_PER_STEP || '20', 10); return Math.max(1, isNaN(r) ? 20 : r); })(),
};

// =============================================================================
// STARTUP CONFIG VALIDATION (F-2-17)
// Fail fast if radius expansion time budget exceeds booking timeout.
// =============================================================================
const TOTAL_RADIUS_EXPANSION_MS = RADIUS_EXPANSION_CONFIG.steps.reduce(
  (sum, step) => sum + step.timeoutMs, 0
);
if (TOTAL_RADIUS_EXPANSION_MS >= BOOKING_CONFIG.TIMEOUT_MS * 0.9) {
  throw new Error(
    `Config error: total radius expansion time (${TOTAL_RADIUS_EXPANSION_MS}ms) must be < 90% of ` +
    `booking timeout (${BOOKING_CONFIG.TIMEOUT_MS}ms). ` +
    `Set BROADCAST_TIMEOUT_SECONDS > ${Math.ceil(TOTAL_RADIUS_EXPANSION_MS / 900)}`
  );
}

// =============================================================================
// REDIS KEY PATTERNS (for distributed timers)
// =============================================================================
export const TIMER_KEYS = {
  BOOKING_EXPIRY: (bookingId: string) => `timer:booking:${bookingId}`,
  COUNTDOWN: (bookingId: string) => `timer:countdown:${bookingId}`,
  RADIUS_STEP: (bookingId: string) => `timer:radius:${bookingId}`,
};

// Redis keys for progressive radius tracking
export const RADIUS_KEYS = {
  CURRENT_STEP: (bookingId: string) => `broadcast:radius:step:${bookingId}`,
  NOTIFIED_SET: (bookingId: string) => `broadcast:notified:${bookingId}`,
};

// =============================================================================
// TERMINAL STATUSES (shared across booking + order guards)
// =============================================================================
// ALLOWLIST pattern (Uber/Stripe): define terminal statuses so any NEW status
// added in the future is automatically treated as "active" and blocked.
// Used by booking-create.service.ts and order-creation.service.ts to prevent
// duplicate bookings/orders while a non-terminal one exists.
// =============================================================================
export const TERMINAL_STATUSES = ['completed', 'cancelled', 'expired'] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

// Timer data interface
export interface BookingTimerData {
  bookingId: string;
  customerId: string;
  createdAt: string;
}

// Timer data for progressive radius expansion steps
export interface RadiusStepTimerData {
  bookingId: string;
  customerId: string;
  vehicleKey: string;
  vehicleType: string;
  vehicleSubtype: string;
  pickupLat: number;
  pickupLng: number;
  currentStep: number;  // 0-indexed (0 = step 1 already done, advance to step 2)
}
