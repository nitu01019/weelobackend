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

// =============================================================================
// ASSIGNMENT STATE MACHINE — Single canonical source for all assignment services
// =============================================================================
// M-20 FIX ENFORCED: in_transit CANNOT go directly to completed.
// Must pass through arrived_at_drop first.
// L-17: partial_delivery is a terminal state (same as completed).
// =============================================================================

export const ASSIGNMENT_VALID_TRANSITIONS: Record<string, readonly string[]> = {
  pending:          ['driver_accepted', 'driver_declined', 'cancelled'],
  driver_accepted:  ['en_route_pickup', 'cancelled'],
  en_route_pickup:  ['at_pickup', 'cancelled'],
  at_pickup:        ['in_transit', 'cancelled'],
  in_transit:       ['arrived_at_drop', 'cancelled'],  // M-20: NO direct in_transit→completed
  arrived_at_drop:  ['completed', 'partial_delivery', 'cancelled'],
  completed:        [],  // Terminal
  partial_delivery: [],  // Terminal (L-17)
  driver_declined:  [],  // Terminal
  cancelled:        [],  // Terminal
} as const;

/**
 * Validates an assignment status transition against the canonical state machine.
 * Throws if the transition is invalid.
 */
export function validateAssignmentTransition(currentStatus: string, targetStatus: string): void {
  if (!isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, currentStatus, targetStatus)) {
    throw new Error(
      `Invalid assignment transition: ${currentStatus} → ${targetStatus}. ` +
      `Allowed: [${(ASSIGNMENT_VALID_TRANSITIONS[currentStatus] || []).join(', ')}]`
    );
  }
}

export const TERMINAL_BOOKING_STATUSES = ['completed', 'cancelled', 'expired'] as const;
export const TERMINAL_ORDER_STATUSES = ['completed', 'cancelled', 'expired'] as const;
export const TERMINAL_ASSIGNMENT_STATUSES = ['completed', 'cancelled', 'driver_declined', 'partial_delivery'] as const;

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
