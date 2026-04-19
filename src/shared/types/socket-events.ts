/**
 * =============================================================================
 * SOCKET EVENT TYPE MAP
 * =============================================================================
 *
 * Typed event interfaces for Socket.IO communication.
 * Derived from SocketEvent in src/shared/services/socket.service.ts.
 *
 * These types are additive — they do NOT modify socket.service.ts.
 * Future refactors can wire them into the Server<> generic.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Payload interfaces (reusable outside of Socket.IO)
// ---------------------------------------------------------------------------

export interface ConnectionAckPayload {
  userId: string;
  role: string;
}

export interface StatusChangePayload {
  entityId: string;
  oldStatus: string;
  newStatus: string;
  entityType: string;
}

export interface FlexHoldStartedPayload {
  orderId: string;
  holdId: string;
  expiresAt: string;
}

export interface FlexHoldExtendedPayload {
  holdId: string;
  newExpiresAt: string;
}

export interface DriverAcceptedPayload {
  assignmentId: string;
  driverName: string;
}

export interface DriverDeclinedPayload {
  assignmentId: string;
  reason?: string;
}

export interface TrucksRemainingUpdatePayload {
  orderId: string;
  filled: number;
  total: number;
}

export interface OrderCancelledPayload {
  orderId: string;
  reason: string;
}

export interface LocationUpdatedPayload {
  userId: string;
  latitude: number;
  longitude: number;
  timestamp?: string;
}

export interface BookingUpdatedPayload {
  bookingId: string;
  status: string;
  [key: string]: unknown;
}

export interface VehicleStatusChangedPayload {
  vehicleId: string;
  status: string;
  reason?: string;
}

export interface DriverStatusChangedPayload {
  driverId: string;
  status: string;
}

export interface NewOrderAlertPayload {
  orderId: string;
  pickupCity?: string;
  dropCity?: string;
  trucksNeeded?: number;
  farePerTruck?: number;
  [key: string]: unknown;
}

export interface BroadcastCountdownPayload {
  orderId: string;
  secondsRemaining: number;
}

export interface HeartbeatPayload {
  driverId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Server -> Client events
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  connected: (data: ConnectionAckPayload) => void;
  booking_updated: (data: BookingUpdatedPayload) => void;
  truck_assigned: (data: Record<string, unknown>) => void;
  trip_assigned: (data: Record<string, unknown>) => void;
  location_updated: (data: LocationUpdatedPayload) => void;
  assignment_status_changed: (data: StatusChangePayload) => void;
  new_broadcast: (data: Record<string, unknown>) => void;
  truck_confirmed: (data: Record<string, unknown>) => void;

  // Booking lifecycle
  booking_cancelled: (data: OrderCancelledPayload) => void;
  booking_expired: (data: { bookingId: string }) => void;
  booking_fully_filled: (data: { bookingId: string }) => void;
  booking_partially_filled: (data: { bookingId: string; filled: number; total: number }) => void;
  no_vehicles_available: (data: { bookingId: string }) => void;
  broadcast_countdown: (data: BroadcastCountdownPayload) => void;

  // Truck request updates
  truck_request_accepted: (data: Record<string, unknown>) => void;
  trucks_remaining_update: (data: TrucksRemainingUpdatePayload) => void;
  request_no_longer_available: (data: { orderId: string }) => void;
  order_status_update: (data: { orderId: string; status: string }) => void;

  // Fleet / vehicle events
  vehicle_registered: (data: Record<string, unknown>) => void;
  vehicle_updated: (data: Record<string, unknown>) => void;
  vehicle_deleted: (data: { vehicleId: string }) => void;
  vehicle_status_changed: (data: VehicleStatusChangedPayload) => void;
  fleet_updated: (data: { transporterId: string }) => void;

  // Driver events
  driver_added: (data: Record<string, unknown>) => void;
  driver_updated: (data: Record<string, unknown>) => void;
  driver_deleted: (data: { driverId: string }) => void;
  driver_status_changed: (data: DriverStatusChangedPayload) => void;
  drivers_updated: (data: { transporterId: string }) => void;

  // Notifications
  new_order_alert: (data: NewOrderAlertPayload) => void;
  accept_confirmation: (data: Record<string, unknown>) => void;

  // Presence
  heartbeat: (data: HeartbeatPayload) => void;
  driver_online: (data: { driverId: string }) => void;
  driver_offline: (data: { driverId: string }) => void;
  driver_timeout: (data: { assignmentId: string }) => void;
  trip_cancelled: (data: { tripId: string; reason?: string }) => void;

  // Broadcast lifecycle
  broadcast_expired: (data: { orderId: string }) => void;
  order_cancelled: (data: OrderCancelledPayload) => void;
  broadcast_state_changed: (data: { orderId: string; state: string }) => void;

  // Assignment lifecycle
  assignment_timeout: (data: { assignmentId: string }) => void;
  driver_presence_timeout: (data: { driverId: string }) => void;

  // Error
  error: (data: { message: string; code?: string }) => void;

  // Allow additional events without breaking the contract
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [event: string]: (...args: any[]) => void;
}

// ---------------------------------------------------------------------------
// Client -> Server events
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  join_booking: (bookingId: string) => void;
  leave_booking: (bookingId: string) => void;
  join_order: (orderId: string) => void;
  leave_order: (orderId: string) => void;
  update_location: (data: { latitude: number; longitude: number }) => void;
  join_transporter: (transporterId: string) => void;
  broadcast_ack: (data: { seq: number }) => void;

  // Allow additional events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [event: string]: (...args: any[]) => void;
}

// ---------------------------------------------------------------------------
// Per-socket data attached by auth handshake
// ---------------------------------------------------------------------------

export interface SocketData {
  userId: string;
  role: string;
  phone: string;
}
