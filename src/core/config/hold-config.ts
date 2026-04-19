/**
 * Single source of truth for hold system timing configuration.
 * PRD 7777 defines 45s for driver accept window.
 * All services MUST import from here -- no local parseInt(process.env...) for these values.
 */
export const HOLD_CONFIG = {
  driverAcceptTimeoutMs: parseInt(process.env.DRIVER_ACCEPT_TIMEOUT_SECONDS || '45', 10) * 1000,
  driverAcceptTimeoutSeconds: parseInt(process.env.DRIVER_ACCEPT_TIMEOUT_SECONDS || '45', 10),
  confirmedHoldMaxSeconds: parseInt(process.env.CONFIRMED_HOLD_MAX_SECONDS || '180', 10),
  flexHoldDurationSeconds: parseInt(process.env.FLEX_HOLD_DURATION_SECONDS || '90', 10),
  flexHoldExtensionSeconds: parseInt(process.env.FLEX_HOLD_EXTENSION_SECONDS || '30', 10),
  flexHoldMaxDurationSeconds: parseInt(process.env.FLEX_HOLD_MAX_DURATION_SECONDS || '130', 10),
  flexHoldMaxExtensions: parseInt(process.env.FLEX_HOLD_MAX_EXTENSIONS || '2', 10),
} as const;

/**
 * Issue #15: Single source of truth for broadcast dedup TTL buffer.
 * Added to BROADCAST_TIMEOUT_MS/1000 to ensure dedup keys outlive the broadcast window.
 * Previously diverged: order-broadcast.service.ts used 180s, query service used 120s.
 */
export const BROADCAST_DEDUP_TTL_BUFFER_SECONDS = 180;
