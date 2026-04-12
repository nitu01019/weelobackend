/**
 * =============================================================================
 * AUTO RE-DISPATCH SERVICE (C-03 Fix)
 * =============================================================================
 *
 * After a driver declines or times out, automatically attempts to find the next
 * available driver from the same transporter's fleet and create a new assignment.
 *
 * Industry reference:
 *   - Uber: On decline/timeout, ride re-enters matching within milliseconds.
 *   - Lyft: Bipartite graph matching; on rejection, request goes back to pool.
 *   - Grab: Cascading fallback to next-ranked candidate.
 *
 * Constraints:
 *   - Max 2 auto-redispatch attempts per booking (Redis counter with 5min TTL)
 *   - Candidate must be online, not the declined driver, and not currently busy
 *   - Non-fatal: failures never break the existing decline/timeout flow
 *   - Existing "Reassign?" notification to transporter is preserved (additive)
 *
 * =============================================================================
 */

import { prismaClient } from '../../shared/database/prisma.service';
import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';
import { driverPresenceService } from '../driver/driver-presence.service';

/** Maximum automatic re-dispatch attempts per booking/order */
const MAX_REDISPATCH_ATTEMPTS = 2;

/** Redis counter TTL in seconds (5 minutes) */
const REDISPATCH_COUNTER_TTL_SECONDS = 300;

/** Parameters for tryAutoRedispatch */
export interface AutoRedispatchParams {
  bookingId?: string;
  orderId?: string;
  transporterId: string;
  vehicleId: string;
  vehicleType: string;
  vehicleSubtype?: string;
  declinedDriverId: string;
  assignmentId: string;
}

/**
 * Attempt to automatically re-dispatch to the next available driver after
 * a decline or timeout. This is a best-effort, non-fatal operation.
 *
 * Returns true if a new assignment was created, false otherwise.
 */
export async function tryAutoRedispatch(params: AutoRedispatchParams): Promise<boolean> {
  const {
    bookingId,
    orderId,
    transporterId,
    vehicleId,
    vehicleType,
    vehicleSubtype,
    declinedDriverId,
    assignmentId,
  } = params;

  const streamId = bookingId || orderId || 'unknown';
  const redisKey = `redispatch:count:${streamId}`;

  // 1. Check redispatch attempt counter
  const currentCount = await redisService.get(redisKey);
  const attempts = currentCount ? parseInt(currentCount, 10) : 0;

  if (attempts >= MAX_REDISPATCH_ATTEMPTS) {
    logger.info(`[AUTO-REDISPATCH] Max attempts (${MAX_REDISPATCH_ATTEMPTS}) reached for ${streamId}, skipping`);
    return false;
  }

  // 2. Query transporter's fleet for candidate drivers
  const drivers = await prismaClient.user.findMany({
    where: {
      transporterId,
      role: 'driver',
      isActive: true,
      id: { not: declinedDriverId },
    },
    select: {
      id: true,
      name: true,
      phone: true,
    },
  });

  if (drivers.length === 0) {
    logger.info(`[AUTO-REDISPATCH] No other drivers in fleet for transporter ${transporterId}`);
    return false;
  }

  // 3. Filter: check each driver for online status and no active assignment
  //    We check sequentially to pick the first match (avoids unnecessary work)
  const activeStatuses = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit', 'arrived_at_drop'];

  let candidateDriver: { id: string; name: string; phone: string | null } | null = null;

  for (const driver of drivers) {
    // Check online status (DB intent + Redis heartbeat)
    const isOnline = await driverPresenceService.isDriverOnline(driver.id);
    if (!isOnline) continue;

    // Check no active assignment
    const activeAssignment = await prismaClient.assignment.findFirst({
      where: {
        driverId: driver.id,
        status: { in: activeStatuses as any },
      },
      select: { id: true },
    });
    if (activeAssignment) continue;

    candidateDriver = driver;
    break;
  }

  if (!candidateDriver) {
    logger.info(`[AUTO-REDISPATCH] No available online driver found for ${streamId} (checked ${drivers.length} drivers)`);
    return false;
  }

  // 4. Create new assignment via the existing assignmentService
  //    Lazy import to avoid circular dependency (same pattern as booking.service)
  const { assignmentService } = require('./assignment.service');

  logger.info(`[AUTO-REDISPATCH] Found candidate driver ${candidateDriver.name} (${candidateDriver.id}) for ${streamId}`);

  if (!bookingId) {
    // Auto-redispatch currently only supports the booking path (single-truck).
    // Multi-truck (orderId) redispatch requires order-accept flow which is
    // more complex. Transporter will handle manually via existing notification.
    logger.info(`[AUTO-REDISPATCH] Skipping order-path redispatch for ${streamId} — transporter handles manually`);
    return false;
  }

  await assignmentService.createAssignment(transporterId, {
    bookingId,
    vehicleId,
    driverId: candidateDriver.id,
  });

  // 5. Increment redispatch counter with TTL
  const newCount = await redisService.incr(redisKey);
  if (newCount === 1) {
    // First increment — set TTL
    await redisService.expire(redisKey, REDISPATCH_COUNTER_TTL_SECONDS);
  }

  logger.info(
    `[AUTO-REDISPATCH] Successfully re-dispatched: ${streamId} → driver ${candidateDriver.name} ` +
    `(attempt ${newCount}/${MAX_REDISPATCH_ATTEMPTS}, prev assignment: ${assignmentId})`
  );

  return true;
}
