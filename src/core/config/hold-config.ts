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
} as const;
