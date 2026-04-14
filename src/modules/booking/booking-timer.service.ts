/**
 * =============================================================================
 * BOOKING MODULE - TIMER & EXPIRY CHECKER SERVICE
 * =============================================================================
 *
 * Handles:
 * - Booking expiry checker (interval-based, Redis-safe)
 * - Processing expired bookings
 * - Processing radius expansion timers
 * - DB-based fallback sweep for missed Redis timers
 * =============================================================================
 */

import { db } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { BOOKING_CONFIG, BookingTimerData, RadiusStepTimerData } from './booking.types';

// Forward reference — set by the facade after all modules load
let _bookingServiceRef: {
  handleBookingTimeout: (bookingId: string, customerId: string) => Promise<void>;
  advanceRadiusStep: (data: RadiusStepTimerData) => Promise<void>;
} | null = null;

export function setBookingServiceRef(ref: typeof _bookingServiceRef): void {
  _bookingServiceRef = ref;
}

// =============================================================================
// EXPIRY CHECKER (Runs on every server instance - Redis ensures no duplicates)
// =============================================================================
let expiryCheckerInterval: NodeJS.Timeout | null = null;
// M-08 FIX: Counter for DB-based expiry sweep — reduced from 60s (12th tick) to 20s (4th tick)
let dbSweepCounter = 0;

/**
 * Start the booking expiry checker
 * This runs on every server instance but uses Redis locks to prevent duplicate processing
 */
function startBookingExpiryChecker(): void {
  if (expiryCheckerInterval) return;

  expiryCheckerInterval = setInterval(async () => {
    try {
      await processExpiredBookings();
      await processRadiusExpansionTimers();

      // M-08 FIX: DB-based fallback sweep every 20s (4 * 5s interval).
      // Reduced from 60s to 20s to shrink blind spot for missed Redis timers.
      // Catches bookings that expired according to DB but were missed by Redis
      // (e.g., Redis restart wiped all timers). Industry pattern: Stripe "completer".
      dbSweepCounter++;
      if (dbSweepCounter % 4 === 0) {
        await sweepExpiredBookingsFromDB();
      }
    } catch (error: unknown) {
      logger.error('Booking expiry checker error', { error: (error as Error).message });
    }
  }, BOOKING_CONFIG.EXPIRY_CHECK_INTERVAL_MS);

  logger.info('📅 Booking expiry checker started (Redis-based, cluster-safe)');
}

/**
 * Process all expired booking timers
 * Uses Redis distributed lock to prevent multiple instances processing the same booking
 */
async function processExpiredBookings(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<BookingTimerData>('timer:booking:');

  for (const timer of expiredTimers) {
    // Per-booking unified lock: both expiry and radius expansion contend on the same key.
    // Prevents race where one expires the booking while the other expands radius.
    // Pattern: Martin Kleppmann -- single lock per entity, not per operation type.
    const lockKey = `lock:booking:${timer.data.bookingId}`;
    const lock = await redisService.acquireLock(lockKey, 'expiry-checker', 30);

    if (!lock.acquired) {
      // Another instance is processing this booking
      continue;
    }

    // FIX-R2-6: Idempotent DB status check after lock (guards against Redis-degraded multi-instance)
    const freshBooking = await db.getBookingById(timer.data.bookingId);
    if (!freshBooking || ['expired', 'completed', 'cancelled', 'fully_filled'].includes(freshBooking.status)) {
      await redisService.releaseLock(lockKey, 'expiry-checker');
      continue;
    }

    try {
      // Cancel timer FIRST to prevent re-processing if handleBookingTimeout throws
      await redisService.cancelTimer(timer.key);
      await _bookingServiceRef!.handleBookingTimeout(timer.data.bookingId, timer.data.customerId);
    } catch (error: unknown) {
      logger.error('Failed to process expired booking', {
        bookingId: timer.data.bookingId,
        error: (error as Error).message
      });
    } finally {
      await redisService.releaseLock(lockKey, 'expiry-checker').catch(() => { });
    }
  }
}

/**
 * DB-based fallback for expired bookings missed by Redis timers.
 * Runs every 60s (12th tick of the 5s interval). Catches bookings that expired
 * according to DB but were never processed (e.g., Redis restart wiped timers).
 *
 * Industry pattern: Stripe "completer" process -- finds unfinished keys
 * and drives them to completion.
 *
 * Handler (handleBookingTimeout) is already idempotent: checks booking status
 * before acting, skips terminal states. Safe to call on already-processed bookings.
 *
 * Fix #17: Booking expiry timer lost on Redis restart.
 */
async function sweepExpiredBookingsFromDB(): Promise<void> {
  const lockKey = 'lock:booking-db-sweep';
  const lock = await redisService.acquireLock(lockKey, 'db-sweep', 55);
  if (!lock.acquired) return;

  try {
    // expiresAt is stored as ISO string in DB (type String in Prisma schema).
    // ISO 8601 strings compare lexicographically, so string lte works correctly.
    const nowIso = new Date().toISOString();
    const expiredBookings = await prismaClient.booking.findMany({
      where: {
        status: { in: ['broadcasting', 'active', 'partially_filled', 'created'] },
        expiresAt: { lte: nowIso },
      },
      select: { id: true, customerId: true },
      take: 50, // Process in batches to bound cycle time
    });

    if (expiredBookings.length === 0) return;

    logger.warn(`[DB-SWEEP] Found ${expiredBookings.length} expired bookings missed by Redis timers`);

    for (const b of expiredBookings) {
      try {
        await _bookingServiceRef!.handleBookingTimeout(b.id, b.customerId);
      } catch (err: unknown) {
        logger.error(`[DB-SWEEP] Failed to expire booking ${b.id}: ${(err as Error).message}`);
      }
    }
  } finally {
    await redisService.releaseLock(lockKey, 'db-sweep').catch(() => {});
  }
}

/**
 * Process radius expansion timers — called from the same expiry checker interval.
 * When a radius step timer expires, advances to the next step and broadcasts
 * to new transporters in the expanded radius.
 */
async function processRadiusExpansionTimers(): Promise<void> {
  const expiredTimers = await redisService.getExpiredTimers<RadiusStepTimerData>('timer:radius:');

  for (const timer of expiredTimers) {
    // Per-booking unified lock: same key as processExpiredBookings ensures mutual exclusion.
    // If expiry gets the lock, radius expansion skips. If expansion gets it, expiry waits.
    const lockKey = `lock:booking:${timer.data.bookingId}`;
    // M-07 FIX: TTL increased from 15s to 30s — radius expansion with Distance Matrix
    // calls can exceed 15s under load, causing premature lock expiry and duplicate steps.
    const lock = await redisService.acquireLock(lockKey, 'radius-expander', 30);

    if (!lock.acquired) continue;

    try {
      // Cancel timer FIRST to prevent re-processing if advanceRadiusStep throws
      await redisService.cancelTimer(timer.key);
      await _bookingServiceRef!.advanceRadiusStep(timer.data);
    } catch (error: unknown) {
      logger.error('[RADIUS EXPANSION] Failed to advance step', {
        bookingId: timer.data.bookingId,
        step: timer.data.currentStep,
        error: (error as Error).message
      });
    } finally {
      await redisService.releaseLock(lockKey, 'radius-expander').catch(() => { });
    }
  }
}

// Exported so server.ts can call it after Redis is ready (no auto-start on import).
export { startBookingExpiryChecker };

/** Stop the booking expiry checker (for graceful shutdown) */
export function stopBookingExpiryChecker(): void {
  if (expiryCheckerInterval) {
    clearInterval(expiryCheckerInterval);
    expiryCheckerInterval = null;
    logger.info('Booking expiry checker stopped');
  }
}
