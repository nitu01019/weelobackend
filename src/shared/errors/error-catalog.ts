/**
 * F-L14: Centralized Error Catalog
 * All error codes used across the codebase in one place.
 * Ensures consistent error codes between order and broadcast paths.
 */
export const ErrorCatalog = {
  // Assignment errors
  ASSIGNMENT_NOT_FOUND: { code: 'ASSIGNMENT_NOT_FOUND', status: 404 },
  ASSIGNMENT_ALREADY_TERMINAL: { code: 'ASSIGNMENT_ALREADY_TERMINAL', status: 409 },
  DRIVER_BUSY: { code: 'DRIVER_BUSY', status: 409 },
  DRIVER_NOT_IN_FLEET: { code: 'DRIVER_NOT_IN_FLEET', status: 403 },
  VEHICLE_UNAVAILABLE: { code: 'VEHICLE_UNAVAILABLE', status: 409 },
  VEHICLE_LOCKED: { code: 'VEHICLE_LOCKED', status: 409 },
  VEHICLE_TYPE_MISMATCH: { code: 'VEHICLE_TYPE_MISMATCH', status: 400 },

  // Broadcast errors
  BROADCAST_NOT_FOUND: { code: 'BROADCAST_NOT_FOUND', status: 404 },
  BROADCAST_EXPIRED: { code: 'BROADCAST_EXPIRED', status: 409 },
  BROADCAST_FILLED: { code: 'BROADCAST_FILLED', status: 409 },

  // Rate limiting
  RATE_LIMITED: { code: 'RATE_LIMITED', status: 429 },
  LOCK_CONTENTION: { code: 'LOCK_CONTENTION', status: 429 },

  // Cancel errors
  CANCEL_IN_PROGRESS: { code: 'CANCEL_IN_PROGRESS', status: 409 },

  // Tracking errors
  TRIP_ALREADY_COMPLETED: { code: 'TRIP_ALREADY_COMPLETED', status: 400 },
  TRIP_NOT_ACTIVE: { code: 'TRIP_NOT_ACTIVE', status: 400 },
  TOO_FAR_FROM_PICKUP: { code: 'TOO_FAR_FROM_PICKUP', status: 400 },
  TOO_FAR_FROM_DROP: { code: 'TOO_FAR_FROM_DROP', status: 400 },
  INVALID_STATUS_TRANSITION: { code: 'INVALID_STATUS_TRANSITION', status: 400 },

  // Auth errors
  FORBIDDEN: { code: 'FORBIDDEN', status: 403 },
  INVALID_PARAM: { code: 'INVALID_PARAM', status: 400 },
  SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', status: 503 },

  // Rating errors
  INVALID_RATING: { code: 'INVALID_RATING', status: 400 },

  // POD errors
  OTP_EXPIRED: { code: 'OTP_EXPIRED', status: 400 },
  OTP_INVALID: { code: 'OTP_INVALID', status: 400 },
} as const;

export type ErrorCode = keyof typeof ErrorCatalog;
