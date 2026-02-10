/**
 * =============================================================================
 * DATABASE SERVICE - PostgreSQL via Prisma
 * =============================================================================
 * 
 * Production database using PostgreSQL with Prisma ORM.
 * 
 * This file contains:
 * 1. Type definitions (interfaces) used by both Prisma and legacy code
 * 2. Database initialization and export
 * 
 * The actual Prisma implementation is in prisma.service.ts
 * 
 * IMPORTANT: JSON file database has been REMOVED.
 * Only PostgreSQL is supported in production.
 * =============================================================================
 */

import { logger } from '../services/logger.service';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

// Database schema
export interface Database {
  users: UserRecord[];
  vehicles: VehicleRecord[];
  bookings: BookingRecord[];
  orders: OrderRecord[];
  truckRequests: TruckRequestRecord[];
  assignments: AssignmentRecord[];
  tracking: TrackingRecord[];
  _meta: {
    version: string;
    lastUpdated: string;
  };
}

// User Record - Customer, Transporter, or Driver
export interface UserRecord {
  id: string;
  phone: string;
  role: 'customer' | 'transporter' | 'driver';
  name: string;
  email?: string;
  profilePhoto?: string;
  
  // Customer specific
  company?: string;
  gstNumber?: string;
  
  // Transporter specific
  businessName?: string;
  businessAddress?: string;
  panNumber?: string;
  
  // Driver specific
  transporterId?: string;  // Which transporter this driver belongs to
  licenseNumber?: string;
  licenseExpiry?: string;
  aadharNumber?: string;
  
  isVerified: boolean;
  isActive: boolean;
  
  // Availability toggle (for transporters/drivers)
  isAvailable?: boolean;
  
  // Language preference (persisted across login sessions)
  preferredLanguage?: string;
  
  // Profile completion status (driver onboarding)
  isProfileCompleted?: boolean;
  
  createdAt: string;
  updatedAt: string;
}

// Vehicle Status - Operational state of the vehicle
export type VehicleStatus = 'available' | 'in_transit' | 'maintenance' | 'inactive';

// Vehicle Record - Registered by Transporter
export interface VehicleRecord {
  id: string;
  transporterId: string;
  assignedDriverId?: string;
  
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  vehicleKey: string;
  capacity: string;
  capacityTons?: number;
  model?: string;
  year?: number;
  
  status: VehicleStatus;
  currentTripId?: string;
  maintenanceReason?: string;
  maintenanceEndDate?: string;
  lastStatusChange?: string;
  
  // Documents
  rcNumber?: string;
  rcExpiry?: string;
  insuranceNumber?: string;
  insuranceExpiry?: string;
  permitNumber?: string;
  permitExpiry?: string;
  fitnessExpiry?: string;
  
  // Photos
  vehiclePhotos?: string[];
  rcPhoto?: string;
  insurancePhoto?: string;
  
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Route Point Record
export interface RoutePointRecord {
  type: 'PICKUP' | 'STOP' | 'DROP';
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  state?: string;
  stopIndex: number;
}

// Stop Wait Timer Record
export interface StopWaitTimerRecord {
  stopIndex: number;
  arrivedAt: string;
  departedAt?: string;
  waitTimeSeconds: number;
}

// Booking Record - Created by Customer
export interface BookingRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  
  pickup: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  drop: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  
  vehicleType: string;
  vehicleSubtype: string;
  trucksNeeded: number;
  trucksFilled: number;
  distanceKm: number;
  pricePerTruck: number;
  totalAmount: number;
  
  goodsType?: string;
  weight?: string;
  
  status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  
  notifiedTransporters: string[];
  
  scheduledAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// Order Record
export interface OrderRecord {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  
  routePoints: RoutePointRecord[];
  currentRouteIndex: number;
  stopWaitTimers: StopWaitTimerRecord[];
  
  pickup: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  drop: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  
  distanceKm: number;
  totalTrucks: number;
  trucksFilled: number;
  totalAmount: number;
  
  goodsType?: string;
  weight?: string;
  cargoWeightKg?: number;
  
  status: 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  
  cancelledAt?: string;
  cancellationReason?: string;
  
  scheduledAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// Truck Request Record
export interface TruckRequestRecord {
  id: string;
  orderId: string;
  requestNumber: number;
  
  vehicleType: string;
  vehicleSubtype: string;
  pricePerTruck: number;
  
  status: 'searching' | 'held' | 'assigned' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  
  heldBy?: string;
  heldAt?: string;
  
  assignedTo?: string;
  assignedTransporterId?: string;
  assignedTransporterName?: string;
  assignedVehicleId?: string;
  assignedVehicleNumber?: string;
  assignedDriverId?: string;
  assignedDriverName?: string;
  assignedDriverPhone?: string;
  
  tripId?: string;
  
  notifiedTransporters: string[];
  
  assignedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Assignment Record
export interface AssignmentRecord {
  id: string;
  bookingId: string;
  truckRequestId?: string;
  orderId?: string;
  transporterId: string;
  transporterName: string;
  vehicleId: string;
  vehicleNumber: string;
  vehicleType: string;
  vehicleSubtype: string;
  driverId: string;
  driverName: string;
  driverPhone: string;
  tripId: string;
  
  status: 'pending' | 'driver_accepted' | 'driver_declined' | 'en_route_pickup' | 'at_pickup' | 'in_transit' | 'completed' | 'cancelled';
  
  assignedAt: string;
  driverAcceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

// Tracking Record
export interface TrackingRecord {
  tripId: string;
  driverId: string;
  vehicleNumber: string;
  bookingId: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  status: string;
  lastUpdated: string;
}

// =============================================================================
// DATABASE INITIALIZATION - PostgreSQL ONLY (Prisma)
// =============================================================================
// 
// IMPORTANT: This backend uses ONLY PostgreSQL via Prisma.
// JSON file database has been REMOVED for production use.
// 
// DATABASE_URL environment variable MUST be set.
// =============================================================================

// Prisma Database - the ONLY database for this backend
let prismaDbInstance: any = null;

// Check if DATABASE_URL is configured
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  logger.error('❌ DATABASE_URL is not set! PostgreSQL is REQUIRED.');
  logger.error('   Please set DATABASE_URL in your environment variables.');
  logger.error('   Example: DATABASE_URL=postgresql://user:pass@host:5432/db');
  // In production, this should fail
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
}

// Initialize Prisma
try {
  const { prismaDb } = require('./prisma.service');
  prismaDbInstance = prismaDb;
  logger.info('✅ PostgreSQL database connected (Prisma)');
  logger.info(`📦 Database: ${DATABASE_URL?.split('@')[1]?.split('/')[0] || 'configured'}`);
} catch (error) {
  logger.error('❌ Failed to initialize PostgreSQL (Prisma):', error);
  throw new Error('PostgreSQL database initialization failed. Cannot start server.');
}

// Export the Prisma database instance - NO FALLBACK to JSON
export const db = prismaDbInstance;

// Async database getter - returns Prisma instance
export async function getDatabase() {
  return prismaDbInstance;
}

logger.info('🗄️  Database: PostgreSQL (Prisma) - ONLY');
