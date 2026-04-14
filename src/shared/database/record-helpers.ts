/**
 * =============================================================================
 * RECORD HELPERS — Conversion functions for Prisma models to Record types
 * =============================================================================
 * Extracted from prisma.service.ts for modularity.
 * =============================================================================
 */

import type { User, Vehicle, Booking, Order, TruckRequest as PrismaTruckRequest, Assignment, Tracking } from '@prisma/client';
import { logger } from '../services/logger.service';
import type {
  UserRecord,
  VehicleRecord,
  BookingRecord,
  OrderRecord,
  TruckRequestRecord,
  AssignmentRecord,
  TrackingRecord,
  LocationRecord,
  RoutePointRecord,
  StopWaitTimerRecord,
} from './record-types';

// Helper to safely parse JSON fields (handles both string and object)
export function parseJsonField<T>(value: unknown): T {
  if (value === null || value === undefined) {
    return value as unknown as T;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (e) {
      logger.warn('Failed to parse JSON field:', e);
      return value as T;
    }
  }
  return value as T;
}

export function toUserRecord(user: User): UserRecord {
  return {
    ...user,
    role: user.role as 'customer' | 'transporter' | 'driver',
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function toVehicleRecord(vehicle: Vehicle): VehicleRecord {
  return {
    ...vehicle,
    status: vehicle.status as VehicleRecord['status'],
    vehiclePhotos: vehicle.vehiclePhotos || [],
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}

export function toBookingRecord(booking: Booking): BookingRecord {
  return {
    ...booking,
    pickup: parseJsonField<LocationRecord>(booking.pickup),
    drop: parseJsonField<LocationRecord>(booking.drop),
    status: booking.status as BookingRecord['status'],
    notifiedTransporters: booking.notifiedTransporters || [],
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

export function toOrderRecord(order: Order): OrderRecord {
  return {
    ...order,
    routePoints: parseJsonField<RoutePointRecord[]>(order.routePoints) || [],
    stopWaitTimers: parseJsonField<StopWaitTimerRecord[]>(order.stopWaitTimers) || [],
    pickup: parseJsonField<LocationRecord>(order.pickup),
    drop: parseJsonField<LocationRecord>(order.drop),
    status: order.status as OrderRecord['status'],
    dispatchState: (order.dispatchState || 'queued') as OrderRecord['dispatchState'],
    dispatchAttempts: typeof order.dispatchAttempts === 'number' ? order.dispatchAttempts : 0,
    dispatchReasonCode: order.dispatchReasonCode || null,
    onlineCandidatesCount: typeof order.onlineCandidatesCount === 'number' ? order.onlineCandidatesCount : 0,
    notifiedCount: typeof order.notifiedCount === 'number' ? order.notifiedCount : 0,
    lastDispatchAt: order.lastDispatchAt ? new Date(order.lastDispatchAt).toISOString() : null,
    loadingStartedAt: order.loadingStartedAt ? new Date(order.loadingStartedAt).toISOString() : null,
    unloadingStartedAt: order.unloadingStartedAt ? new Date(order.unloadingStartedAt).toISOString() : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function toTruckRequestRecord(request: PrismaTruckRequest): TruckRequestRecord {
  return {
    ...request,
    heldBy: request.heldById,
    assignedTo: request.assignedTransporterId,
    status: request.status as TruckRequestRecord['status'],
    notifiedTransporters: request.notifiedTransporters || [],
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

export function toAssignmentRecord(assignment: Assignment): AssignmentRecord {
  return {
    ...assignment,
    bookingId: assignment.bookingId || '',
    status: assignment.status as AssignmentRecord['status'],
  };
}

export function toTrackingRecord(tracking: Tracking): TrackingRecord {
  return {
    ...tracking,
    bookingId: tracking.bookingId || '',
    lastUpdated: tracking.lastUpdated.toISOString(),
  };
}

// Vehicle string normalization helpers
export function normalizeVehicleString(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/feet/gi, 'ft')
    .replace(/foot/gi, 'ft')
    .replace(/ton/gi, 't')
    .replace(/wheeler/gi, 'w')
    .replace(/axle/gi, 'ax')
    .replace(/[\s_-]+/g, '')
    .replace(/\+/g, 'plus');
}

export function vehicleStringsMatch(str1: string, str2: string): boolean {
  return normalizeVehicleString(str1) === normalizeVehicleString(str2);
}
