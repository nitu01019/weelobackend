/**
 * =============================================================================
 * TRACKING MODULE - SHARED TYPES, CONSTANTS, AND REDIS KEYS
 * =============================================================================
 */

// =============================================================================
// REDIS KEYS
// =============================================================================

export const REDIS_KEYS = {
  /** Current driver location: driver:location:{driverId} */
  DRIVER_LOCATION: (driverId: string) => `driver:location:${driverId}`,

  /** Trip tracking data: driver:trip:{tripId} */
  TRIP_LOCATION: (tripId: string) => `driver:trip:${tripId}`,

  /** Location history: driver:history:{tripId} */
  TRIP_HISTORY: (tripId: string) => `driver:history:${tripId}`,

  /** Fleet active drivers: fleet:{transporterId} */
  FLEET_DRIVERS: (transporterId: string) => `fleet:${transporterId}`,
  /** Index of transporter IDs that currently have active fleet sets */
  ACTIVE_FLEET_TRANSPORTERS: 'fleet:index:transporters',

  /** Active trips by booking: booking:trips:{bookingId} */
  BOOKING_TRIPS: (bookingId: string) => `booking:trips:${bookingId}`,

  // =========================================================================
  // OFFLINE RESILIENCE KEYS (NEW)
  // =========================================================================

  /** Last accepted timestamp for a driver: driver:last_ts:{driverId}
   *  Used to reject out-of-order/duplicate points */
  DRIVER_LAST_TS: (driverId: string) => `driver:last_ts:${driverId}`,

  /** Driver online status: driver:status:{driverId}
   *  Values: ONLINE | OFFLINE | UNKNOWN */
  DRIVER_STATUS: (driverId: string) => `driver:status:${driverId}`,

  /** History persist state per trip: tracking:persist-state:{tripId}
   *  Stores last persisted point info to avoid redundant history writes */
  HISTORY_PERSIST_STATE: (tripId: string) => `tracking:persist-state:${tripId}`,
};

// TTL values (in seconds)
export const TTL = {
  LOCATION: 300,           // 5 minutes - location expires if no update
  TRIP: 86400,             // 24 hours - trip data
  HISTORY: 86400 * 7,      // 7 days - keep history for analytics
};

export const HISTORY_PERSIST_MIN_INTERVAL_MS = parseInt(process.env.TRACKING_HISTORY_MIN_INTERVAL_MS || '15000', 10);
export const HISTORY_PERSIST_MIN_MOVEMENT_METERS = parseInt(process.env.TRACKING_HISTORY_MIN_MOVEMENT_METERS || '75', 10);
export const HISTORY_STATE_MAX_ENTRIES = parseInt(process.env.TRACKING_HISTORY_STATE_MAX_ENTRIES || '50000', 10);
export const TRACKING_STREAM_ENABLED = process.env.TRACKING_STREAM_ENABLED === 'true';

// =============================================================================
// TYPES
// =============================================================================

export interface LocationData {
  tripId: string;
  driverId: string;
  transporterId?: string;
  vehicleId?: string;
  vehicleNumber: string;
  bookingId: string;
  orderId?: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  accuracy?: number;
  status: string;
  lastUpdated: string;  // ISO string for Redis
}

export interface HistoryPersistState {
  latitude: number;
  longitude: number;
  timestampMs: number;
  status: string;
}

/**
 * Fleet tracking response - for transporter to see all their trucks
 */
export interface FleetTrackingResponse {
  transporterId: string;
  activeDrivers: number;
  drivers: Array<{
    driverId: string;
    driverName?: string;
    vehicleNumber: string;
    tripId?: string;
    latitude: number;
    longitude: number;
    speed: number;
    bearing: number;
    status: string;
    lastUpdated: string;
  }>;
}
