/**
 * =============================================================================
 * STATS REPOSITORY — Stats/analytics + raw data queries
 * =============================================================================
 */

import { getPrismaClient } from '../prisma-client';
import {
  toUserRecord,
  toVehicleRecord,
  toBookingRecord,
  toOrderRecord,
  toTruckRequestRecord,
  toAssignmentRecord,
  toTrackingRecord,
} from '../record-helpers';

export async function getStats() {
  const prisma = getPrismaClient();
  const [
    users,
    customers,
    transporters,
    drivers,
    vehicles,
    activeVehicles,
    bookings,
    activeBookings,
    assignments
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: 'customer' } }),
    prisma.user.count({ where: { role: 'transporter' } }),
    prisma.user.count({ where: { role: 'driver' } }),
    prisma.vehicle.count(),
    prisma.vehicle.count({ where: { isActive: true } }),
    prisma.booking.count(),
    prisma.booking.count({ where: { status: 'active' } }),
    prisma.assignment.count(),
  ]);

  return {
    users,
    customers,
    transporters,
    drivers,
    vehicles,
    activeVehicles,
    bookings,
    activeBookings,
    assignments,
    dbType: 'PostgreSQL (Prisma)',
  };
}

export async function getRawData() {
  const prisma = getPrismaClient();
  const HARD_LIMIT = 1000;

  const [users, vehicles, bookings, orders, truckRequests, assignments, tracking] = await Promise.all([
    prisma.user.findMany({ take: HARD_LIMIT, orderBy: { createdAt: 'desc' } }),
    prisma.vehicle.findMany({ take: HARD_LIMIT, orderBy: { createdAt: 'desc' } }),
    prisma.booking.findMany({ take: HARD_LIMIT, orderBy: { createdAt: 'desc' } }),
    prisma.order.findMany({ take: HARD_LIMIT, orderBy: { createdAt: 'desc' } }),
    prisma.truckRequest.findMany({ take: HARD_LIMIT, orderBy: { createdAt: 'desc' } }),
    prisma.assignment.findMany({ take: HARD_LIMIT, orderBy: { assignedAt: 'desc' } }),
    prisma.tracking.findMany({ take: HARD_LIMIT, orderBy: { lastUpdated: 'desc' } }),
  ]);

  return {
    users: users.map(u => toUserRecord(u)),
    vehicles: vehicles.map(v => toVehicleRecord(v)),
    bookings: bookings.map(b => toBookingRecord(b)),
    orders: orders.map(o => toOrderRecord(o)),
    truckRequests: truckRequests.map(r => toTruckRequestRecord(r)),
    assignments: assignments.map(a => toAssignmentRecord(a)),
    tracking: tracking.map(t => toTrackingRecord(t)),
    _meta: {
      version: '2.0.0',
      lastUpdated: new Date().toISOString(),
      truncated: true,
      limit: HARD_LIMIT,
    }
  };
}
