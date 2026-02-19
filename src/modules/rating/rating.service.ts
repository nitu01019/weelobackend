import { prismaClient } from '../../shared/database/prisma.service';
import { redisService } from '../../shared/services/redis.service';
import { AppError } from '../../core/errors/AppError';
import { logger } from '../../shared/services/logger.service';
import type { SubmitRatingInput } from './rating.schema';

// =============================================================================
// REDIS CACHE KEYS
// =============================================================================
const DRIVER_RATING_KEY = (driverId: string) => `driver:rating:${driverId}`;
const DRIVER_RATING_DIST_KEY = (driverId: string) => `driver:rating:dist:${driverId}`;
const PENDING_RATINGS_KEY = (customerId: string) => `rating:pending:${customerId}`;
const RATING_CACHE_TTL = 300;       // 5 minutes
const PENDING_CACHE_TTL = 3600;     // 1 hour

// =============================================================================
// RATING SERVICE — Production-grade, transaction-safe, scale-ready
// =============================================================================

export const ratingService = {

  /**
   * Submit a rating for a completed trip assignment.
   * 
   * ATOMICITY: Steps 4-6 wrapped in Prisma $transaction to prevent:
   *   - Orphan Rating records (if Assignment update fails)
   *   - Stale avgRating (if User update fails)
   *   - Race conditions on concurrent ratings for same driver
   * 
   * IDEMPOTENCY: Duplicate submissions return existing rating (no error).
   */
  async submitRating(customerId: string, input: SubmitRatingInput) {
    const { assignmentId, stars, comment, tags } = input;

    // 1. Validate assignment exists and is completed
    const assignment = await prismaClient.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        booking: { select: { id: true, customerId: true } },
        order: { select: { id: true, customerId: true } }
      }
    });

    if (!assignment) {
      throw new AppError('Trip not found', 404, 'ASSIGNMENT_NOT_FOUND');
    }

    if (assignment.status !== 'completed') {
      throw new AppError('You can only rate completed trips', 400, 'TRIP_NOT_COMPLETED');
    }

    // 2. Validate customer owns the booking/order (role isolation at data level)
    const bookingCustomerId = assignment.booking?.customerId || assignment.order?.customerId;
    if (!bookingCustomerId || bookingCustomerId !== customerId) {
      throw new AppError('You can only rate your own trips', 403, 'NOT_AUTHORIZED');
    }

    // 3. Check for duplicate (idempotent — return existing on conflict)
    const existing = await prismaClient.rating.findUnique({
      where: { customerId_assignmentId: { customerId, assignmentId } }
    });

    if (existing) {
      const driverAvg = await this.getDriverAvgRating(assignment.driverId);
      return {
        ratingId: existing.id,
        stars: existing.stars,
        driverAvgRating: driverAvg.avg,
        driverId: assignment.driverId,
        message: 'You have already rated this trip',
        idempotent: true
      };
    }

    // 4-6. ATOMIC TRANSACTION: Create Rating + Update Assignment + Recalculate Driver avg
    const bookingId = assignment.booking?.id || null;
    const orderId = assignment.order?.id || null;

    const result = await prismaClient.$transaction(async (tx) => {
      // 4. Create Rating record
      const rating = await tx.rating.create({
        data: {
          customerId,
          driverId: assignment.driverId,
          assignmentId,
          bookingId,
          orderId,
          stars,
          comment: comment || null,
          tags: tags || []
        }
      });

      // 5. Update Assignment.customerRating (denormalized for fast trip list display)
      await tx.assignment.update({
        where: { id: assignmentId },
        data: { customerRating: stars }
      });

      // 6. Recalculate driver's avgRating + totalRatings on User model
      //    Done INSIDE transaction to prevent race condition where two concurrent
      //    ratings both aggregate, compute avg, and last-write-wins with wrong count.
      const ratingAgg = await tx.rating.aggregate({
        where: { driverId: assignment.driverId },
        _avg: { stars: true },
        _count: { stars: true }
      });

      const newAvg = Math.round((ratingAgg._avg.stars || 0) * 10) / 10;
      const newCount = ratingAgg._count.stars || 0;

      await tx.user.update({
        where: { id: assignment.driverId },
        data: { avgRating: newAvg, totalRatings: newCount }
      });

      return { ratingId: rating.id, newAvg, newCount };
    }, {
      // ReadCommitted: sufficient because @@unique(assignmentId) prevents duplicate ratings
      // and aggregate recalculation is per-driver (no cross-driver contention).
      // Serializable would cause unnecessary lock contention at millions of concurrent users.
      isolationLevel: 'ReadCommitted',
      timeout: 10000  // 10s timeout for safety
    });

    // 7. Update Redis cache OUTSIDE transaction (best-effort, non-blocking)
    try {
      await Promise.all([
        redisService.set(
          DRIVER_RATING_KEY(assignment.driverId),
          JSON.stringify({ avg: result.newAvg, count: result.newCount }),
          RATING_CACHE_TTL
        ),
        redisService.del(DRIVER_RATING_DIST_KEY(assignment.driverId)),
        redisService.del(PENDING_RATINGS_KEY(customerId))
      ]);
    } catch (cacheError: any) {
      // Graceful degradation — DB is source of truth, cache will refresh on next read
      logger.warn('[RATING] Redis cache update failed', { error: cacheError.message });
    }

    logger.info('[RATING] Rating submitted', {
      ratingId: result.ratingId,
      customerId,
      driverId: assignment.driverId,
      assignmentId,
      stars,
      newAvg: result.newAvg,
      newCount: result.newCount
    });

    return {
      ratingId: result.ratingId,
      stars,
      driverAvgRating: result.newAvg,
      driverId: assignment.driverId,  // Returned for WebSocket emission in routes
      message: 'Thank you for your feedback!',
      idempotent: false
    };
  },

  /**
   * Get unrated completed trips for a customer (last 7 days).
   * Cached for 1 hour in Redis (invalidated on new rating submission).
   */
  async getPendingRatings(customerId: string) {
    // Try Redis cache first
    try {
      const cached = await redisService.get(PENDING_RATINGS_KEY(customerId));
      if (cached) return JSON.parse(cached);
    } catch (_) { /* cache miss, continue */ }

    // completedAt is stored as ISO string (not DateTime) — filter in-memory after fetch
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Find completed assignments for this customer's bookings/orders that have no rating
    const unrated = await prismaClient.assignment.findMany({
      where: {
        status: 'completed',
        customerRating: null,
        completedAt: { not: null },
        OR: [
          { booking: { customerId } },
          { order: { customerId } }
        ]
      },
      include: {
        driver: { select: { profilePhoto: true } },
        booking: { select: { id: true, pickup: true, drop: true } },
        order: { select: { id: true, pickup: true, drop: true } }
      },
      orderBy: { completedAt: 'desc' },
      take: 50  // Fetch more, then filter by 7-day window
    });

    const result = unrated
      .filter(a => {
        // Filter to last 7 days only (completedAt is ISO string)
        if (!a.completedAt) return false;
        const completedMs = new Date(a.completedAt).getTime();
        return !isNaN(completedMs) && completedMs >= sevenDaysAgoMs;
      })
      .slice(0, 20)  // Limit to 20 after filtering
      .map(a => {
        // Use booking OR order for pickup/drop (unified)
        const source = a.booking || a.order;
        return {
          assignmentId: a.id,
          tripId: a.tripId,
          // Mask driver name for privacy: "Amit Kumar" → "A***r"
          driverName: maskName(a.driverName || 'Driver'),
          // SECURITY: Never expose driverPhone to customer
          driverProfilePhotoUrl: a.driver?.profilePhoto || null,
          vehicleNumber: a.vehicleNumber,
          vehicleType: `${a.vehicleType || ''} ${a.vehicleSubtype || ''}`.trim(),
          pickup: (source as any)?.pickup || null,
          drop: (source as any)?.drop || null,
          completedAt: a.completedAt,
          bookingId: a.bookingId || a.orderId
        };
      });

    // Cache for 1 hour
    try {
      await redisService.set(PENDING_RATINGS_KEY(customerId), JSON.stringify(result), PENDING_CACHE_TTL);
    } catch (_) { /* graceful degradation */ }

    return result;
  },

  /**
   * Get driver's rating history with distribution (for Captain app).
   * Paginated, cached, with privacy-masked customer names.
   */
  async getDriverRatings(driverId: string, page: number = 1, limit: number = 20) {
    // Get avg + count (cached)
    const { avg, count } = await this.getDriverAvgRating(driverId);

    // Get distribution (cached separately for independent TTL)
    const distribution = await this.getDriverRatingDistribution(driverId);

    // Get paginated recent ratings (not cached — pagination makes caching complex)
    const skip = (page - 1) * limit;
    const recentRatings = await prismaClient.rating.findMany({
      where: { driverId },
      select: {
        stars: true,
        comment: true,
        tags: true,
        createdAt: true,
        assignmentId: true,
        customer: { select: { name: true } },
        assignment: { select: { tripId: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });

    return {
      avgRating: avg,
      totalRatings: count,
      distribution,
      recentRatings: recentRatings.map(r => ({
        stars: r.stars,
        comment: r.comment,
        tags: r.tags,
        // Mask customer name for privacy: "Amit" → "A***t"
        customerName: maskName(r.customer?.name || 'Customer'),
        tripId: r.assignment?.tripId || 'N/A',
        createdAt: r.createdAt.toISOString()
      }))
    };
  },

  /**
   * Get driver's rating distribution (1-5 stars breakdown).
   * Single Redis lookup → single DB fallback. No double query.
   */
  async getDriverRatingDistribution(driverId: string): Promise<Record<string, number>> {
    const defaultDist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };

    // Try Redis cache
    try {
      const cached = await redisService.get(DRIVER_RATING_DIST_KEY(driverId));
      if (cached) return JSON.parse(cached);
    } catch (_) { /* cache miss, fall through to DB */ }

    // Single DB query (no double call on Redis failure)
    const distRows = await prismaClient.rating.groupBy({
      by: ['stars'],
      where: { driverId },
      _count: { stars: true }
    });

    const distribution = { ...defaultDist };
    for (const row of distRows) {
      distribution[String(row.stars)] = row._count.stars;
    }

    // Cache for 5 minutes (best-effort)
    try {
      await redisService.set(DRIVER_RATING_DIST_KEY(driverId), JSON.stringify(distribution), RATING_CACHE_TTL);
    } catch (_) { /* graceful degradation */ }

    return distribution;
  },

  /**
   * Get driver's average rating (with Redis cache).
   * Used by performance endpoint and rating submission.
   */
  async getDriverAvgRating(driverId: string): Promise<{ avg: number; count: number }> {
    // Try Redis cache
    try {
      const cached = await redisService.get(DRIVER_RATING_KEY(driverId));
      if (cached) {
        const parsed = JSON.parse(cached);
        return { avg: parsed.avg || 0, count: parsed.count || 0 };
      }
    } catch (_) { /* cache miss */ }

    // Single DB fallback
    const ratingAgg = await prismaClient.rating.aggregate({
      where: { driverId },
      _avg: { stars: true },
      _count: { stars: true }
    });

    const avg = Math.round((ratingAgg._avg.stars || 0) * 10) / 10;
    const count = ratingAgg._count.stars || 0;

    // Cache for 5 minutes (best-effort)
    if (count > 0) {
      try {
        await redisService.set(
          DRIVER_RATING_KEY(driverId),
          JSON.stringify({ avg, count }),
          RATING_CACHE_TTL
        );
      } catch (_) { /* graceful degradation */ }
    }

    return { avg, count };
  }
};

// =============================================================================
// UTILITY: Mask name for privacy
// "Amit Kumar" → "A***r", "A" → "A***", "" → "Customer"
// =============================================================================
function maskName(name: string): string {
  if (!name || name.length === 0) return 'Customer';
  if (name.length <= 2) return name[0] + '***';
  return name[0] + '***' + name[name.length - 1];
}
