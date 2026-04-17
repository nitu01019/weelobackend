/**
 * ⚠ AUTO-GENERATED — do not edit.
 *
 * Source of truth: packages/contracts/events.asyncapi.yaml,
 * packages/contracts/schemas/enums.proto.
 *
 * Regenerate via: `node packages/contracts/codegen.mjs`.
 * Governed by F-C-52 (events) and F-C-78 (enums) — see .planning/phase4/INDEX.md.
 */

// Canonical enum registry — mirrors prisma/schema.prisma exactly.
// Use the `*.fromBackendString(raw)` companions when decoding wire data:
// returns 'UNKNOWN' on schema drift so consumers can log + alert without throwing.

export const HoldPhase = {
  UNKNOWN: 'UNKNOWN',
  FLEX: 'FLEX',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  RELEASED: 'RELEASED',
} as const;
export type HoldPhase = typeof HoldPhase[keyof typeof HoldPhase];

const HoldPhase_VALUES: ReadonlySet<string> = new Set(['FLEX', 'CONFIRMED', 'EXPIRED', 'RELEASED']);

/**
 * Decode a backend-origin wire string into a canonical HoldPhase value.
 * Returns 'UNKNOWN' on drift so the caller can log + alert without throwing.
 */
export function HoldPhase_fromBackendString(raw: string | null | undefined): HoldPhase {
  if (raw != null && HoldPhase_VALUES.has(raw)) return raw as HoldPhase;
  return HoldPhase.UNKNOWN;
}

export const VehicleStatus = {
  UNKNOWN: 'UNKNOWN',
  AVAILABLE: 'available',
  ON_HOLD: 'on_hold',
  IN_TRANSIT: 'in_transit',
  MAINTENANCE: 'maintenance',
  INACTIVE: 'inactive',
} as const;
export type VehicleStatus = typeof VehicleStatus[keyof typeof VehicleStatus];

const VehicleStatus_VALUES: ReadonlySet<string> = new Set(['available', 'on_hold', 'in_transit', 'maintenance', 'inactive']);

/**
 * Decode a backend-origin wire string into a canonical VehicleStatus value.
 * Returns 'UNKNOWN' on drift so the caller can log + alert without throwing.
 */
export function VehicleStatus_fromBackendString(raw: string | null | undefined): VehicleStatus {
  if (raw != null && VehicleStatus_VALUES.has(raw)) return raw as VehicleStatus;
  return VehicleStatus.UNKNOWN;
}

export const BookingStatus = {
  UNKNOWN: 'UNKNOWN',
  CREATED: 'created',
  BROADCASTING: 'broadcasting',
  ACTIVE: 'active',
  PARTIALLY_FILLED: 'partially_filled',
  FULLY_FILLED: 'fully_filled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;
export type BookingStatus = typeof BookingStatus[keyof typeof BookingStatus];

const BookingStatus_VALUES: ReadonlySet<string> = new Set(['created', 'broadcasting', 'active', 'partially_filled', 'fully_filled', 'in_progress', 'completed', 'cancelled', 'expired']);

/**
 * Decode a backend-origin wire string into a canonical BookingStatus value.
 * Returns 'UNKNOWN' on drift so the caller can log + alert without throwing.
 */
export function BookingStatus_fromBackendString(raw: string | null | undefined): BookingStatus {
  if (raw != null && BookingStatus_VALUES.has(raw)) return raw as BookingStatus;
  return BookingStatus.UNKNOWN;
}

export const AssignmentStatus = {
  UNKNOWN: 'UNKNOWN',
  PENDING: 'pending',
  DRIVER_ACCEPTED: 'driver_accepted',
  DRIVER_DECLINED: 'driver_declined',
  EN_ROUTE_PICKUP: 'en_route_pickup',
  AT_PICKUP: 'at_pickup',
  IN_TRANSIT: 'in_transit',
  ARRIVED_AT_DROP: 'arrived_at_drop',
  COMPLETED: 'completed',
  PARTIAL_DELIVERY: 'partial_delivery',
  CANCELLED: 'cancelled',
} as const;
export type AssignmentStatus = typeof AssignmentStatus[keyof typeof AssignmentStatus];

const AssignmentStatus_VALUES: ReadonlySet<string> = new Set(['pending', 'driver_accepted', 'driver_declined', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop', 'completed', 'partial_delivery', 'cancelled']);

/**
 * Decode a backend-origin wire string into a canonical AssignmentStatus value.
 * Returns 'UNKNOWN' on drift so the caller can log + alert without throwing.
 */
export function AssignmentStatus_fromBackendString(raw: string | null | undefined): AssignmentStatus {
  if (raw != null && AssignmentStatus_VALUES.has(raw)) return raw as AssignmentStatus;
  return AssignmentStatus.UNKNOWN;
}

/**
 * Convenience namespace grouping every enum's `fromBackendString` companion.
 * Usage: `fromBackendString.HoldPhase(raw)`.
 */
export const fromBackendString = {
  HoldPhase: HoldPhase_fromBackendString,
  VehicleStatus: VehicleStatus_fromBackendString,
  BookingStatus: BookingStatus_fromBackendString,
  AssignmentStatus: AssignmentStatus_fromBackendString,
} as const;
