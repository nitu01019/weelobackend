/**
 * =============================================================================
 * DATABASE SERVICE - PostgreSQL via Prisma
 * =============================================================================
 *
 * Production database using PostgreSQL with Prisma ORM.
 *
 * Record types are now defined in prisma.service.ts (single source of truth)
 * and re-exported here so that all 77+ consumers get the exact same types
 * that PrismaDatabaseService methods return.
 *
 * The actual Prisma implementation is in prisma.service.ts
 *
 * IMPORTANT: JSON file database has been REMOVED.
 * Only PostgreSQL is supported in production.
 * =============================================================================
 */

import { logger } from '../services/logger.service';
import type { PrismaDatabaseService } from './prisma.service';

// =============================================================================
// TYPE RE-EXPORTS — single source of truth lives in prisma.service.ts
// =============================================================================
// Previously these were duplicate interface definitions that diverged over time
// (prisma.service.ts used `| null`, db.ts used `| undefined`). Now unified.
export type {
  LocationRecord,
  RoutePointRecord,
  StopWaitTimerRecord,
  UserRecord,
  VehicleRecord,
  BookingRecord,
  OrderRecord,
  TruckRequestRecord,
  AssignmentRecord,
  TrackingRecord,
} from './prisma.service';

// Import for use in the Database interface below
import type {
  UserRecord,
  VehicleRecord,
  BookingRecord,
  OrderRecord,
  TruckRequestRecord,
  AssignmentRecord,
  TrackingRecord,
} from './prisma.service';

// =============================================================================
// TYPES UNIQUE TO db.ts
// =============================================================================

// Database schema (used by getRawData and similar aggregate endpoints)
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

// Vehicle Status — string union alias for convenience (matches VehicleRecord.status)
export type VehicleStatus = 'available' | 'on_hold' | 'in_transit' | 'maintenance' | 'inactive';

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
// KNOWN-ANY: Typed as PrismaDatabaseService internally, but exported as any
// because ~30 consumer files access properties not on the public interface.
// Use prismaClient from prisma.service.ts for type-safe access in new code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db: any = prismaDbInstance;

// Async database getter - returns Prisma instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getDatabase(): Promise<any> {
  return prismaDbInstance;
}

logger.info('🗄️  Database: PostgreSQL (Prisma) - ONLY');
