/**
 * =============================================================================
 * AVAILABILITY TYPES — All types, interfaces, REDIS_KEYS constants
 * =============================================================================
 * Extracted from availability.service.ts for modularity.
 * =============================================================================
 */

// =============================================================================
// Lua script for atomic heartbeat SET update (M-16 FIX)
// =============================================================================
export const LUA_HEARTBEAT_SET_UPDATE = `
redis.call('DEL', KEYS[1])
for i = 1, #ARGV - 1 do
  redis.call('SADD', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return 1
`;

// =============================================================================
// REDIS KEY PATTERNS
// =============================================================================
export const REDIS_KEYS = {
  /** Geospatial index: geo:transporters:{vehicleKey} */
  GEO_TRANSPORTERS: (vehicleKey: string) => `geo:transporters:${vehicleKey}`,

  /** Transporter details hash: transporter:details:{transporterId} */
  TRANSPORTER_DETAILS: (transporterId: string) => `transporter:details:${transporterId}`,

  /** Transporter's current vehicle key: transporter:vehicle:{transporterId} */
  TRANSPORTER_VEHICLE: (transporterId: string) => `transporter:vehicle:${transporterId}`,

  /** Transporter's indexed vehicle keys set: transporter:vehicle:keys:{transporterId} */
  TRANSPORTER_VEHICLE_KEYS: (transporterId: string) => `transporter:vehicle:keys:${transporterId}`,

  /** All online transporters set: online:transporters */
  ONLINE_TRANSPORTERS: 'online:transporters',
};

// =============================================================================
// TYPES
// =============================================================================

export interface TransporterAvailability {
  transporterId: string;
  driverId?: string;
  vehicleKey: string;
  vehicleId: string;
  latitude: number;
  longitude: number;
  lastSeen: number;
  isOnTrip: boolean;
}

export interface AvailabilityStats {
  totalOnline: number;
  byVehicleType: Record<string, number>;
  byGeohash: Record<string, number>;
  redisMode: boolean;
}

export interface NearbyTransporter {
  transporterId: string;
  distance: number;
  vehicleKey: string;
  vehicleId: string;
  latitude: number;
  longitude: number;
}
