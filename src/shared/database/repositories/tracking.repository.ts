/**
 * =============================================================================
 * TRACKING REPOSITORY — Tracking queries
 * =============================================================================
 */

import { getPrismaClient } from '../prisma-client';
import { toTrackingRecord } from '../record-helpers';
import type { TrackingRecord } from '../record-types';

export async function updateTracking(tracking: TrackingRecord): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.tracking.upsert({
    where: { tripId: tracking.tripId },
    update: {
      latitude: tracking.latitude,
      longitude: tracking.longitude,
      speed: tracking.speed,
      bearing: tracking.bearing,
      status: tracking.status,
      lastUpdated: new Date(),
    },
    create: {
      tripId: tracking.tripId,
      driverId: tracking.driverId,
      vehicleNumber: tracking.vehicleNumber,
      bookingId: tracking.bookingId || null,
      latitude: tracking.latitude,
      longitude: tracking.longitude,
      speed: tracking.speed,
      bearing: tracking.bearing,
      status: tracking.status,
    }
  });
}

export async function getTrackingByTrip(tripId: string): Promise<TrackingRecord | undefined> {
  const prisma = getPrismaClient();
  const tracking = await prisma.tracking.findUnique({ where: { tripId } });
  return tracking ? toTrackingRecord(tracking) : undefined;
}

export async function getTrackingByBooking(bookingId: string): Promise<TrackingRecord[]> {
  const prisma = getPrismaClient();
  const trackings = await prisma.tracking.findMany({ where: { bookingId } });
  return trackings.map(t => toTrackingRecord(t));
}
