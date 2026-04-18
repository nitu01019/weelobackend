/**
 * =============================================================================
 * DRIVER MODULE - PERFORMANCE SERVICE
 * =============================================================================
 *
 * Dashboard, performance metrics, earnings, trips, and active trip queries.
 * Includes shared rating/on-time helpers used by both dashboard and performance.
 * =============================================================================
 */

import { db, BookingRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { safeJsonParse } from '../../shared/utils/safe-json.utils';
import { DEFAULT_AVG_SPEED_KMH } from '../../shared/utils/geospatial.utils';
import { prismaClient } from '../../shared/database/prisma.service';
import { driverPresenceService } from './driver-presence.service';
import { DashboardData, EarningsData, PerformanceData } from './driver.types';
import { getErrorMessage } from '../../shared/utils/error.utils';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';

class DriverPerformanceService {

  // ==========================================================================
  // SHARED HELPERS — DRY: Used by both getDashboard() and getPerformance()
  // ==========================================================================

  /**
   * Get real driver rating from Rating table (Redis cached, 5min TTL).
   *
   * SCALABILITY: Redis GET O(1) → cache hit in <1ms. DB aggregate O(log n)
   * on indexed column → sub-10ms even at millions of ratings.
   *
   * GRACEFUL DEGRADATION: If Rating table doesn't exist (pre-migration)
   * or Redis is down, returns { avg: 0, count: 0 } — honest zero, not fake 4.5.
   */
  private async getDriverRating(driverId: string): Promise<{ avg: number; count: number }> {
    try {
      const cacheKey = `driver:rating:${driverId}`;
      const cached = await redisService.get(cacheKey);
      if (cached) {
        const parsed = safeJsonParse<{ avg?: number; count?: number }>(cached, { avg: 0, count: 0 });
        return { avg: parsed.avg || 0, count: parsed.count || 0 };
      }

      const ratingAgg = await prismaClient.rating.aggregate({
        where: { driverId },
        _avg: { stars: true },
        _count: { stars: true }
      });
      const avg = ratingAgg._avg.stars || 0;
      const count = ratingAgg._count.stars || 0;

      if (count > 0) {
        await redisService.set(cacheKey, JSON.stringify({ avg, count }), 300);
      }
      return { avg, count };
    } catch (err: unknown) {
      logger.warn('[DRIVER SERVICE] Rating lookup failed, using defaults', {
        driverId, error: getErrorMessage(err)
      });
      return { avg: 0, count: 0 };
    }
  }

  /**
   * Calculate on-time delivery rate from completed assignments.
   *
   * On-time = completed within (distanceKm / 30 km/h) * 60 + 30min buffer.
   * 30 km/h = Indian road conditions for trucks.
   * 30min buffer = loading, traffic, etc.
   *
   * SCALABILITY: Batch query for distances (no N+1). O(n) where n = completed trips.
   * For drivers with 10K+ trips, consider adding date-range filter.
   *
   * EDGE CASES:
   * - No completed trips → 100% (benefit of the doubt)
   * - No timestamps → assume on-time (don't penalize for missing data)
   * - Negative/zero distance → assume on-time
   * - Invalid timestamps (endMs <= startMs) → assume on-time
   */
  private async calculateOnTimeRate(driverId: string): Promise<{
    rate: number;
    totalDistance: number;
  }> {
    try {
      // C-8 fix: 90-day rolling window + take limit to prevent unbounded query
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - 90);

      const completedAssignments = await prismaClient.assignment.findMany({
        where: { driverId, status: 'completed', bookingId: { not: null }, completedAt: { gte: windowStart.toISOString() } },
        select: { bookingId: true, orderId: true, startedAt: true, completedAt: true },
        take: 500
      });

      if (completedAssignments.length === 0) {
        return { rate: 100, totalDistance: 0 };
      }

      // Batch fetch distances from both Booking and Order tables
      const bookingIds = completedAssignments
        .map(a => a.bookingId)
        .filter((id): id is string => id !== null);
      const orderIds = completedAssignments
        .map(a => a.orderId)
        .filter((id): id is string => id !== null && !bookingIds.includes(id));

      const [bookings, orders] = await Promise.all([
        bookingIds.length > 0
          ? prismaClient.booking.findMany({
            where: { id: { in: bookingIds } },
            select: { id: true, distanceKm: true }
          })
          : [],
        orderIds.length > 0
          ? prismaClient.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, distanceKm: true }
          })
          : []
      ]);

      // Build distance map (O(n) lookup)
      const distanceMap = new Map<string, number>();
      for (const b of bookings) distanceMap.set(b.id, Math.max(0, b.distanceKm || 0));
      for (const o of orders) distanceMap.set(o.id, Math.max(0, o.distanceKm || 0));

      // Total distance
      const totalDistance = Array.from(distanceMap.values()).reduce((sum, d) => sum + d, 0);

      // On-time calculation — F-A-28: pull AVG_SPEED_KMH from SSOT
      const AVG_SPEED_KMH = DEFAULT_AVG_SPEED_KMH;
      const BUFFER_MINUTES = 30;
      const withTimes = completedAssignments.filter(a => a.startedAt && a.completedAt);

      if (withTimes.length === 0) {
        return { rate: 100, totalDistance };
      }

      const onTimeCount = withTimes.filter(a => {
        const startMs = new Date(a.startedAt!).getTime();
        const endMs = new Date(a.completedAt!).getTime();
        if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return true;
        const refId = a.bookingId || a.orderId;
        const distanceKm = refId ? (distanceMap.get(refId) || 0) : 0;
        if (distanceKm <= 0) return true;
        const estimatedMinutes = (distanceKm / AVG_SPEED_KMH) * 60 + BUFFER_MINUTES;
        const actualMinutes = (endMs - startMs) / 60000;
        return actualMinutes <= estimatedMinutes;
      }).length;

      return {
        rate: Math.round((onTimeCount / withTimes.length) * 100 * 10) / 10,
        totalDistance: Math.round(totalDistance * 10) / 10
      };
    } catch (err: unknown) {
      logger.warn('[DRIVER SERVICE] On-time/distance calc failed, using defaults', {
        driverId, error: getErrorMessage(err)
      });
      return { rate: 100, totalDistance: 0 };
    }
  }

  // ==========================================================================
  // DRIVER PERFORMANCE
  // ==========================================================================

  /**
   * Get driver performance metrics from real assignment data.
   *
   * All metrics are calculated from indexed Prisma queries:
   *   - @@index([driverId])        → all assignments for this driver
   *   - @@index([driverId, status]) → status-specific counts
   *
   * SCALABILITY:
   *   - COUNT queries on indexed columns → O(log n), sub-50ms even at millions of rows
   *   - No JOINs needed — all data is on the Assignment table
   *   - Can add Redis cache (5min TTL) if needed at scale
   *
   * DATA ISOLATION:
   *   - Every query is WHERE driverId = ? — driver only sees their own data
   *
   * NO FAKE DATA:
   *   - Every metric is derived from real assignment records
   *   - Only `rating` is a placeholder (needs customer rating system in Phase 5+)
   *
   * @param driverId - The driver's user ID
   * @returns PerformanceData matching Captain app's PerformanceResponseData
   */
  async getPerformance(driverId: string): Promise<PerformanceData> {
    // Input validation — guard against empty/invalid driverId
    if (!driverId || typeof driverId !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Valid driver ID is required');
    }

    try {
      logger.info('[DRIVER SERVICE] Getting performance metrics', { driverId });

      // -----------------------------------------------------------------------
      // 1. Count assignments by status — all use @@index([driverId, status])
      //    Promise.all() runs 4 indexed COUNT queries in parallel (~5ms each)
      // -----------------------------------------------------------------------
      const [
        totalAssignments,
        completedCount,
        declinedCount,
        _cancelledCount
      ] = await Promise.all([
        prismaClient.assignment.count({ where: { driverId } }),
        prismaClient.assignment.count({ where: { driverId, status: 'completed' } }),
        prismaClient.assignment.count({ where: { driverId, status: 'driver_declined' } }),
        prismaClient.assignment.count({ where: { driverId, status: 'cancelled' } })
      ]);

      // -----------------------------------------------------------------------
      // 2-3. Rates, distance, rating — all via shared DRY helpers
      // -----------------------------------------------------------------------

      // Acceptance rate: % of assignments NOT declined out of total
      const acceptanceRate = totalAssignments > 0
        ? ((totalAssignments - declinedCount) / totalAssignments) * 100
        : 100;

      // Completion rate: % of accepted assignments that were completed
      const acceptedCount = totalAssignments - declinedCount;
      const completionRate = acceptedCount > 0
        ? (completedCount / acceptedCount) * 100
        : 100;

      // On-time rate + total distance (shared helper — DRY)
      const onTimeResult = await this.calculateOnTimeRate(driverId);
      const onTimeDeliveryRate = onTimeResult.rate;
      const totalDistanceKm = onTimeResult.totalDistance;

      // Rating from Rating table (shared helper — Redis cached, DRY)
      const ratingResult = await this.getDriverRating(driverId);
      const rating = ratingResult.avg;
      const totalRatings = ratingResult.count;

      const result: PerformanceData = {
        rating,
        totalRatings,
        acceptanceRate: Math.round(acceptanceRate * 10) / 10,
        onTimeDeliveryRate: Math.round(onTimeDeliveryRate * 10) / 10,
        completionRate: Math.round(completionRate * 10) / 10,
        totalTrips: totalAssignments,
        totalDistance: Math.round(totalDistanceKm * 10) / 10
      };

      logger.info('[DRIVER SERVICE] Performance metrics calculated', {
        driverId,
        totalTrips: result.totalTrips,
        acceptanceRate: result.acceptanceRate,
        completionRate: result.completionRate
      });

      return result;
    } catch (error: unknown) {
      logger.error('[DRIVER SERVICE] Failed to get performance', {
        driverId,
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack?.substring(0, 300) : undefined
      });

      // Wrap non-AppError exceptions (e.g. Prisma connection errors) for consistent API response
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to retrieve performance metrics');
    }
  }

  // ==========================================================================
  // DRIVER DASHBOARD
  // ==========================================================================

  /**
   * Get driver dashboard data with real metrics from assignment records.
   *
   * FIXED: rating and acceptanceRate are now calculated from real data
   * (previously hardcoded as 4.5 and 85).
   */
  async getDashboard(userId: string): Promise<DashboardData> {
    const bookings = await db.getBookingsByDriver(userId);

    const today = new Date().toISOString().split('T')[0];
    const completedBookings = bookings.filter((b: BookingRecord) => b.status === 'completed');
    const todayBookings = completedBookings.filter((b: BookingRecord) =>
      b.updatedAt?.startsWith(today)
    );

    const totalEarnings = completedBookings.reduce((sum: number, b: BookingRecord) => sum + (b.totalAmount || 0), 0);
    const todayEarnings = todayBookings.reduce((sum: number, b: BookingRecord) => sum + (b.totalAmount || 0), 0);

    // -----------------------------------------------------------------------
    // Real metrics from shared helpers (DRY — same logic as getPerformance())
    // All wrapped in individual try/catch for graceful degradation
    // -----------------------------------------------------------------------
    let acceptanceRate = 100;
    let rating = 0;
    let totalRatings = 0;
    let onTimeDeliveryRate = 100;
    let totalDistance = 0;

    // Acceptance rate from assignment counts
    try {
      const [totalAssignments, declinedCount] = await Promise.all([
        prismaClient.assignment.count({ where: { driverId: userId } }),
        prismaClient.assignment.count({ where: { driverId: userId, status: 'driver_declined' } })
      ]);
      acceptanceRate = totalAssignments > 0
        ? Math.round(((totalAssignments - declinedCount) / totalAssignments) * 100 * 10) / 10
        : 100;
    } catch (err: unknown) {
      logger.warn('[DRIVER SERVICE] Dashboard acceptance rate failed, using default', {
        userId, error: getErrorMessage(err)
      });
    }

    // Rating from shared helper (Redis cached, 5min TTL)
    const ratingResult = await this.getDriverRating(userId);
    rating = ratingResult.avg;
    totalRatings = ratingResult.count;

    // On-time rate + total distance from shared helper
    const onTimeResult = await this.calculateOnTimeRate(userId);
    onTimeDeliveryRate = onTimeResult.rate;
    totalDistance = onTimeResult.totalDistance;

    return {
      stats: {
        totalTrips: completedBookings.length,
        completedToday: todayBookings.length,
        totalEarnings,
        todayEarnings,
        rating: Math.round(rating * 10) / 10,
        totalRatings,
        acceptanceRate,
        onTimeDeliveryRate,
        totalDistance,
        todayDistance: totalDistance // Backward compat for ViewModel
      },
      recentTrips: completedBookings.slice(0, 5).map((b: BookingRecord) => ({
        id: b.id,
        pickup: b.pickup?.address || 'Unknown',
        dropoff: b.drop?.address || 'Unknown',
        price: b.totalAmount,
        date: b.updatedAt,
        status: b.status
      })),
      availability: {
        isOnline: await driverPresenceService.isDriverOnline(userId),
        lastOnline: null
      }
    };
  }

  /**
   * Get driver earnings
   */
  async getEarnings(userId: string, period: string = 'week'): Promise<EarningsData> {
    const bookings = await db.getBookingsByDriver(userId);
    const completedBookings = bookings.filter((b: BookingRecord) => b.status === 'completed');

    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const periodBookings = completedBookings.filter((b: BookingRecord) =>
      new Date(b.updatedAt || b.createdAt) >= startDate
    );

    const totalEarnings = periodBookings.reduce((sum: number, b: BookingRecord) => sum + (b.totalAmount || 0), 0);

    // Group by date for breakdown
    const byDate: { [key: string]: { amount: number; trips: number } } = {};
    periodBookings.forEach((b: BookingRecord) => {
      const date = (b.updatedAt || b.createdAt).split('T')[0];
      if (!byDate[date]) {
        byDate[date] = { amount: 0, trips: 0 };
      }
      byDate[date].amount += b.totalAmount || 0;
      byDate[date].trips += 1;
    });

    const tripCount = periodBookings.length;
    const avgPerTrip = tripCount > 0 ? totalEarnings / tripCount : 0;

    return {
      period,
      totalEarnings,
      totalTrips: tripCount,
      averagePerTrip: avgPerTrip,
      // Backward compatibility — old field names
      tripCount,
      avgPerTrip,
      breakdown: Object.entries(byDate).map(([date, data]) => ({
        date,
        earnings: data.amount,    // Captain app expects 'earnings'
        amount: data.amount,      // Backward compat — old field name
        trips: data.trips,
        distance: 0               // Captain app expects 'distance' (placeholder)
      }))
    };
  }

  /**
   * Get driver trips
   */
  async getTrips(
    userId: string,
    options: { status?: string; limit: number; offset: number }
  ) {
    let bookings = await db.getBookingsByDriver(userId);

    if (options.status) {
      bookings = bookings.filter((b: BookingRecord) => b.status === options.status);
    }

    const total = bookings.length;
    const trips = bookings
      .sort((a: BookingRecord, b: BookingRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(options.offset, options.offset + options.limit)
      .map((b: BookingRecord) => ({
        id: b.id,
        pickup: b.pickup?.address || 'Unknown',
        dropoff: b.drop?.address || 'Unknown',
        price: b.totalAmount,
        status: b.status,
        date: b.createdAt,
        customer: b.customerName || 'Customer'
      }));

    return {
      trips,
      total,
      hasMore: options.offset + options.limit < total
    };
  }

  /**
   * Get active trip for driver
   */
  async getActiveTrip(userId: string) {
    const bookings = await db.getBookingsByDriver(userId);
    const activeStatuses = ['active', 'partially_filled', 'in_progress'];

    const activeTrip = bookings.find((b: BookingRecord) => activeStatuses.includes(b.status));

    if (!activeTrip) {
      return null;
    }

    return {
      id: activeTrip.id,
      status: activeTrip.status,
      pickup: {
        address: activeTrip.pickup?.address,
        location: { lat: activeTrip.pickup?.latitude, lng: activeTrip.pickup?.longitude }
      },
      dropoff: {
        address: activeTrip.drop?.address,
        location: { lat: activeTrip.drop?.latitude, lng: activeTrip.drop?.longitude }
      },
      price: activeTrip.totalAmount,
      customer: {
        name: activeTrip.customerName,
        phone: maskPhoneForExternal(activeTrip.customerPhone)
      },
      createdAt: activeTrip.createdAt
    };
  }
}

export const driverPerformanceService = new DriverPerformanceService();
