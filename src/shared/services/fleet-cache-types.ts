/**
 * =============================================================================
 * FLEET CACHE TYPES - Shared constants, keys, and interfaces
 * =============================================================================
 *
 * Extracted from fleet-cache.service.ts (file-split).
 * Shared between fleet-cache-read.service.ts and fleet-cache-write.service.ts.
 * =============================================================================
 */

// F-B-03: FleetCache owns the `fleetcache:*` namespace. Tracking owns `fleet:*`
// (fleet:{transporterId}, fleet:index:transporters). Do NOT collapse these two
// prefixes — clearAll() scans only `fleetcache:*` and refuses to touch tracking.
export const FLEET_CACHE_PREFIX = 'fleetcache:';

export const CACHE_KEYS = {
  VEHICLES: (transporterId: string) => `fleetcache:vehicles:${transporterId}`,
  VEHICLES_BY_TYPE: (transporterId: string, type: string, subtype?: string) =>
    `fleetcache:vehicles:${transporterId}:type:${type.toLowerCase()}${subtype ? `:${subtype.toLowerCase()}` : ''}`,
  VEHICLES_AVAILABLE: (transporterId: string) => `fleetcache:vehicles:available:${transporterId}`,
  VEHICLE: (vehicleId: string) => `fleetcache:vehicle:${vehicleId}`,
  DRIVERS: (transporterId: string) => `fleetcache:drivers:${transporterId}`,
  DRIVERS_AVAILABLE: (transporterId: string) => `fleetcache:drivers:available:${transporterId}`,
  DRIVER: (driverId: string) => `fleetcache:driver:${driverId}`,
  AVAILABILITY_SNAPSHOT: (transporterId: string, vehicleType: string) =>
    `fleetcache:snapshot:${transporterId}:${vehicleType.toLowerCase()}`
};

export const CACHE_TTL = {
  VEHICLE_LIST: 300,
  DRIVER_LIST: 300,
  INDIVIDUAL: 600,
  SNAPSHOT: 60
};

export interface CachedVehicle {
  id: string;
  transporterId: string;
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  capacityTons: number;
  status: 'available' | 'on_hold' | 'in_transit' | 'maintenance' | 'inactive';
  currentTripId?: string;
  assignedDriverId?: string;
  isActive: boolean;
  lastUpdated: string;
}

export interface CachedDriver {
  id: string;
  transporterId: string;
  name: string;
  phone: string;
  profilePhotoUrl?: string;
  rating: number;
  totalTrips: number;
  status: 'active' | 'inactive' | 'suspended';
  isAvailable: boolean;
  isOnline: boolean;
  currentTripId?: string;
  lastUpdated: string;
}

export interface AvailabilitySnapshot {
  transporterId: string;
  transporterName: string;
  vehicleType: string;
  vehicleSubtype?: string;
  totalOwned: number;
  available: number;
  inTransit: number;
  lastUpdated: string;
}
