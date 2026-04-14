/**
 * =============================================================================
 * BOOKING REPOSITORY — Booking CRUD operations
 * =============================================================================
 */

import { BookingStatus, Prisma } from '@prisma/client';
import { getPrismaClient, sanitizeDbError, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../prisma-client';
import { toBookingRecord } from '../record-helpers';
import type { BookingRecord } from '../record-types';
import { logger } from '../../services/logger.service';
import { generateVehicleKeyCandidates } from '../../services/vehicle-key.service';
import { getVehiclesByTransporter } from './vehicle.repository';

export async function createBooking(booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'>): Promise<BookingRecord> {
  const prisma = getPrismaClient();
  const created = await prisma.booking.create({
    data: {
      ...booking,
      pickup: booking.pickup as unknown as Prisma.InputJsonValue,
      drop: booking.drop as unknown as Prisma.InputJsonValue,
      status: booking.status as BookingStatus,
    }
  });
  logger.info(`Booking created: ${booking.id} (${booking.vehicleType}, ${booking.trucksNeeded} trucks)`);
  return toBookingRecord(created);
}

export async function getBookingById(id: string): Promise<BookingRecord | undefined> {
  const prisma = getPrismaClient();
  const booking = await prisma.booking.findUnique({ where: { id } });
  return booking ? toBookingRecord(booking) : undefined;
}

export async function getBookingsByCustomer(customerId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<BookingRecord[]> {
  const prisma = getPrismaClient();
  const bookings = await prisma.booking.findMany({
    where: { customerId },
    take: Math.min(limit, MAX_PAGE_SIZE),
    orderBy: { createdAt: 'desc' }
  });
  return bookings.map(b => toBookingRecord(b));
}

export async function getBookingsByDriver(driverId: string): Promise<BookingRecord[]> {
  const prisma = getPrismaClient();
  const assignments = await prisma.assignment.findMany({
    where: { driverId },
    select: { bookingId: true }
  });
  const bookingIds = assignments.map(a => a.bookingId).filter(Boolean) as string[];

  const bookings = await prisma.booking.findMany({
    where: { id: { in: bookingIds } }
  });
  return bookings.map(b => toBookingRecord(b));
}

export async function getActiveBookingsForTransporter(transporterId: string): Promise<BookingRecord[]> {
  const prisma = getPrismaClient();
  const vehicles = await getVehiclesByTransporter(transporterId);

  const transporterVehicleKeys = new Set<string>();
  const vehicleTypes = new Set<string>();
  for (const v of vehicles) {
    if (!v.isActive) continue;
    vehicleTypes.add(v.vehicleType);
    const candidates = generateVehicleKeyCandidates(v.vehicleType, v.vehicleSubtype || '');
    for (const key of candidates) transporterVehicleKeys.add(key);
  }

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ['active', 'partially_filled'] },
      vehicleType: { in: [...vehicleTypes] }
    }
  });

  return bookings
    .filter(b => {
      const bookingKeys = generateVehicleKeyCandidates(b.vehicleType, b.vehicleSubtype || '');
      return bookingKeys.some(key => transporterVehicleKeys.has(key));
    })
    .map(b => toBookingRecord(b));
}

export async function updateBooking(id: string, updates: Partial<BookingRecord>): Promise<BookingRecord> {
  const prisma = getPrismaClient();
  try {
    const { createdAt: _ca, updatedAt: _ua, ...data } = updates as Partial<BookingRecord> & { createdAt?: unknown; updatedAt?: unknown };
    const updated = await prisma.booking.update({
      where: { id },
      data: {
        ...data,
        pickup: data.pickup ? data.pickup as unknown as Prisma.InputJsonValue : undefined,
        drop: data.drop ? data.drop as unknown as Prisma.InputJsonValue : undefined,
        status: data.status ? data.status as BookingStatus : undefined,
      }
    });
    return toBookingRecord(updated);
  } catch (error) {
    logger.error('DB operation failed', { operation: 'updateBooking', id, error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    throw error;
  }
}
