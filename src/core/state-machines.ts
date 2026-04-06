// =============================================================================
// STATE MACHINES — Centralized transition validation for all entity lifecycles
// =============================================================================
// Industry pattern (Uber/Ola/Porter): All status changes go through a state
// machine that validates the transition is legal. Prevents impossible states
// like "completed → active" or "cancelled → in_progress".
// =============================================================================

export const BOOKING_VALID_TRANSITIONS: Record<string, readonly string[]> = {
  created:          ['broadcasting', 'cancelled', 'expired'],
  broadcasting:     ['active', 'cancelled', 'expired'],
  active:           ['partially_filled', 'fully_filled', 'cancelled', 'expired'],
  partially_filled: ['active', 'fully_filled', 'cancelled', 'expired'],
  fully_filled:     ['in_progress', 'cancelled'],
  in_progress:      ['completed', 'cancelled'],
  completed:        [],  // Terminal
  cancelled:        [],  // Terminal
  expired:          [],  // Terminal
} as const;

export const ORDER_VALID_TRANSITIONS: Record<string, readonly string[]> = {
  created:          ['broadcasting', 'cancelled', 'expired'],
  broadcasting:     ['active', 'cancelled', 'expired'],
  active:           ['partially_filled', 'fully_filled', 'cancelled', 'expired'],
  partially_filled: ['active', 'fully_filled', 'cancelled', 'expired'],
  fully_filled:     ['in_progress', 'cancelled'],
  in_progress:      ['completed', 'cancelled'],
  completed:        [],  // Terminal
  cancelled:        [],  // Terminal
  expired:          [],  // Terminal
} as const;

export const VEHICLE_VALID_TRANSITIONS: Record<string, readonly string[]> = {
  available:    ['on_hold', 'in_transit', 'maintenance', 'inactive'],
  on_hold:      ['in_transit', 'available'],
  in_transit:   ['available', 'maintenance'],
  maintenance:  ['available', 'inactive'],
  inactive:     ['available', 'maintenance'],
} as const;

export const TERMINAL_BOOKING_STATUSES = ['completed', 'cancelled', 'expired'] as const;
export const TERMINAL_ORDER_STATUSES = ['completed', 'cancelled', 'expired'] as const;
export const TERMINAL_ASSIGNMENT_STATUSES = ['completed', 'cancelled', 'driver_declined'] as const;

/**
 * Validates a state transition against a state machine.
 * Returns true if the transition is valid, false otherwise.
 */
export function isValidTransition(
  transitions: Record<string, readonly string[]>,
  currentStatus: string,
  newStatus: string
): boolean {
  const allowed = transitions[currentStatus];
  if (!allowed) return false;
  return allowed.includes(newStatus);
}

/**
 * Validates and throws if the transition is invalid.
 * Use this in service methods that change status.
 */
export function assertValidTransition(
  entityType: string,
  transitions: Record<string, readonly string[]>,
  currentStatus: string,
  newStatus: string
): void {
  if (!isValidTransition(transitions, currentStatus, newStatus)) {
    throw new Error(
      `Invalid ${entityType} transition: ${currentStatus} → ${newStatus}. ` +
      `Allowed: [${(transitions[currentStatus] || []).join(', ')}]`
    );
  }
}
