/**
 * ⚠ AUTO-GENERATED — do not edit.
 *
 * Source of truth: packages/contracts/events.asyncapi.yaml,
 * packages/contracts/schemas/enums.proto.
 *
 * Regenerate via: `node packages/contracts/codegen.mjs`.
 * Governed by F-C-52 (events) and F-C-78 (enums) — see .planning/phase4/INDEX.md.
 */

// Canonical registry of 74 socket event names + 1 legacy alias(es).
// Legacy hand-rolled map in socket.service.ts:137-237 now re-exports from here.

export const SocketEvent = {
  CONNECTED: 'connected',
  BOOKING_UPDATED: 'booking_updated',
  TRUCK_ASSIGNED: 'truck_assigned',
  TRIP_ASSIGNED: 'trip_assigned',
  LOCATION_UPDATED: 'location_updated',
  ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
  NEW_BROADCAST: 'new_broadcast',
  TRUCK_CONFIRMED: 'truck_confirmed',
  BOOKING_EXPIRED: 'booking_expired',
  BOOKING_FULLY_FILLED: 'booking_fully_filled',
  BOOKING_PARTIALLY_FILLED: 'booking_partially_filled',
  NO_VEHICLES_AVAILABLE: 'no_vehicles_available',
  BROADCAST_COUNTDOWN: 'broadcast_countdown',
  TRUCK_REQUEST_ACCEPTED: 'truck_request_accepted',
  TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available',
  ORDER_STATUS_UPDATE: 'order_status_update',
  VEHICLE_REGISTERED: 'vehicle_registered',
  VEHICLE_UPDATED: 'vehicle_updated',
  VEHICLE_DELETED: 'vehicle_deleted',
  VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
  FLEET_UPDATED: 'fleet_updated',
  DRIVER_ADDED: 'driver_added',
  DRIVER_UPDATED: 'driver_updated',
  DRIVER_DELETED: 'driver_deleted',
  DRIVER_STATUS_CHANGED: 'driver_status_changed',
  DRIVERS_UPDATED: 'drivers_updated',
  NEW_ORDER_ALERT: 'new_order_alert',
  ACCEPT_CONFIRMATION: 'accept_confirmation',
  ERROR: 'error',
  HEARTBEAT: 'heartbeat',
  DRIVER_ONLINE: 'driver_online',
  DRIVER_OFFLINE: 'driver_offline',
  DRIVER_TIMEOUT: 'driver_timeout',
  ASSIGNMENT_TIMEOUT: 'assignment_timeout',
  DRIVER_PRESENCE_TIMEOUT: 'driver_presence_timeout',
  TRIP_CANCELLED: 'trip_cancelled',
  BROADCAST_EXPIRED: 'broadcast_expired',
  ORDER_CANCELLED: 'order_cancelled',
  BROADCAST_STATE_CHANGED: 'broadcast_state_changed',
  BOOKING_CANCELLED: 'booking_cancelled',
  DRIVER_APPROACHING: 'driver_approaching',
  DRIVER_MAY_BE_OFFLINE: 'driver_may_be_offline',
  DRIVER_CONNECTIVITY_ISSUE: 'driver_connectivity_issue',
  HOLD_EXPIRED: 'hold_expired',
  TRANSPORTER_STATUS_CHANGED: 'transporter_status_changed',
  DRIVER_ACCEPTED: 'driver_accepted',
  DRIVER_DECLINED: 'driver_declined',
  FLEX_HOLD_STARTED: 'flex_hold_started',
  FLEX_HOLD_EXTENDED: 'flex_hold_extended',
  CASCADE_REASSIGNED: 'cascade_reassigned',
  DRIVER_RATING_UPDATED: 'driver_rating_updated',
  PROFILE_COMPLETED: 'profile_completed',
  PROFILE_PHOTO_UPDATED: 'profile_photo_updated',
  LICENSE_PHOTOS_UPDATED: 'license_photos_updated',
  ASSIGNMENT_STALE: 'assignment_stale',
  ORDER_NO_SUPPLY: 'order_no_supply',
  ROUTE_PROGRESS_UPDATED: 'route_progress_updated',
  ORDER_COMPLETED: 'order_completed',
  BOOKING_COMPLETED: 'booking_completed',
  ORDER_PROGRESS_UPDATE: 'order_progress_update',
  ORDER_TIMEOUT_EXTENDED: 'order_timeout_extended',
  ORDER_EXPIRED: 'order_expired',
  ORDER_STATE_SYNC: 'order_state_sync',
  JOIN_BOOKING: 'join_booking',
  LEAVE_BOOKING: 'leave_booking',
  JOIN_ORDER: 'join_order',
  LEAVE_ORDER: 'leave_order',
  UPDATE_LOCATION: 'update_location',
  JOIN_TRANSPORTER: 'join_transporter',
  BROADCAST_ACK: 'broadcast_ack',
  DRIVER_SOS: 'driver_sos',
  JOIN_TRIP: 'join_trip',
  ETA_UPDATED: 'eta_updated',
  // ----- Legacy aliases (same wire value, additional TS member) -----
  BROADCAST_CANCELLED: 'order_cancelled',
} as const;

export type SocketEventName = typeof SocketEvent[keyof typeof SocketEvent];

// De-duplicated set of wire values (aliases collapse to their target).
export const ALL_SOCKET_EVENTS: readonly SocketEventName[] = Object.freeze(
  Array.from(new Set(Object.values(SocketEvent))) as SocketEventName[]
);
