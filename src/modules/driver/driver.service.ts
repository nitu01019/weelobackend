/**
 * =============================================================================
 * DRIVER MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for driver operations.
 * =============================================================================
 */

import { v4 as uuid } from 'uuid';
import { db, BookingRecord, UserRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';
import { fleetCacheService } from '../../shared/services/fleet-cache.service';
import { redisService } from '../../shared/services/redis.service';
import { CreateDriverInput } from './driver.schema';
import { prismaClient } from '../../shared/database/prisma.service';

// =============================================================================
// REDIS KEY PATTERNS — Driver Online/Offline Presence System
// =============================================================================
// driver:presence:{driverId}                → SET with TTL 35s (live connectivity)
// transporter:{transporterId}:onlineDrivers → SET of online driverIds
//
// TTL DESIGN:
//   Heartbeat interval = 12 seconds
//   Redis TTL = 35 seconds
//   → 3 retry windows before auto-offline
//   → Handles 4G instability / network jitter
//
// ZERO DB WRITES for heartbeat — only Redis SET with TTL extension
// DB writes ONLY on manual button press (isAvailable = true/false)
// =============================================================================
const PRESENCE_TTL_SECONDS = 35;  // Must be > 2x heartbeat interval
const PRESENCE_KEY = (driverId: string) => `driver:presence:${driverId}`;
const ONLINE_DRIVERS_KEY = (transporterId: string) => `transporter:${transporterId}:onlineDrivers`;

// =============================================================================
// REDIS KEY PATTERNS — Toggle Spam Protection (Production-Grade)
// =============================================================================
// driver:toggle:cooldown:{driverId}   → timestamp, TTL 5s (min interval between toggles)
// driver:toggle:count:{driverId}      → counter, TTL 300s (max 10 toggles per 5 min window)
// driver:toggle:lock:{driverId}       → "1", NX, TTL 3s (prevents race conditions)
//
// SCALABILITY:
//   All operations are O(1) Redis commands (INCR, SET NX, GET)
//   Sub-1ms per check — handles millions of drivers
//   Rate limiter stops 99%+ spam at Redis layer, zero DB impact
//
// FLOW:
//   1. Check rate limit (cooldown + window)
//   2. Check idempotency (skip if state unchanged)
//   3. Acquire short lock (prevent race conditions)
//   4. Execute state change (goOnline/goOffline)
//   5. Set cooldown + release lock
// =============================================================================
const TOGGLE_COOLDOWN_KEY = (driverId: string) => `driver:toggle:cooldown:${driverId}`;
const TOGGLE_COUNT_KEY = (driverId: string) => `driver:toggle:count:${driverId}`;
const TOGGLE_LOCK_KEY = (driverId: string) => `driver:toggle:lock:${driverId}`;
// TOGGLE_PENDING_KEY removed — offline debounce was removed (caused critical bug)

const TOGGLE_COOLDOWN_SECONDS = 5;        // Min 5s between toggles
const TOGGLE_MAX_PER_WINDOW = 10;          // Max 10 toggles per window
const TOGGLE_WINDOW_SECONDS = 300;         // 5-minute window
const TOGGLE_LOCK_TTL_SECONDS = 3;         // Lock TTL for processing

interface DashboardData {
  stats: {
    totalTrips: number;
    completedToday: number;
    totalEarnings: number;
    todayEarnings: number;
    rating: number;
    totalRatings: number;
    acceptanceRate: number;
    onTimeDeliveryRate: number;
    totalDistance: number;
    todayDistance: number;
  };
  recentTrips: any[];
  availability: {
    isOnline: boolean;
    lastOnline: string | null;
  };
}

interface AvailabilityData {
  isOnline: boolean;
  currentLocation?: {
    latitude: number;
    longitude: number;
  };
  lastUpdated: string;
}

interface EarningsData {
  period: string;
  totalEarnings: number;
  totalTrips: number;
  averagePerTrip: number;
  /** @deprecated Use totalTrips */
  tripCount: number;
  /** @deprecated Use averagePerTrip */
  avgPerTrip: number;
  breakdown: {
    date: string;
    earnings: number;  // Captain app field name
    amount: number;    // Backward compat
    trips: number;
    distance: number;  // Captain app expects this
  }[];
}

/**
 * Performance metrics returned by GET /api/v1/driver/performance
 * 
 * Matches Captain app's PerformanceResponseData exactly:
 *   rating, totalRatings, acceptanceRate, onTimeDeliveryRate,
 *   completionRate, totalTrips, totalDistance
 */
interface PerformanceData {
  rating: number;
  totalRatings: number;
  acceptanceRate: number;
  onTimeDeliveryRate: number;
  completionRate: number;
  totalTrips: number;
  totalDistance: number;
}

class DriverService {

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
        const parsed = JSON.parse(cached);
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
    } catch (err: any) {
      logger.warn('[DRIVER SERVICE] Rating lookup failed, using defaults', {
        driverId, error: err.message
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
      const completedAssignments = await prismaClient.assignment.findMany({
        where: { driverId, status: 'completed', bookingId: { not: null } },
        select: { bookingId: true, orderId: true, startedAt: true, completedAt: true }
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

      // On-time calculation
      const AVG_SPEED_KMH = 30;
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
    } catch (err: any) {
      logger.warn('[DRIVER SERVICE] On-time/distance calc failed, using defaults', {
        driverId, error: err.message
      });
      return { rate: 100, totalDistance: 0 };
    }
  }

  // ==========================================================================
  // TRANSPORTER - DRIVER MANAGEMENT
  // ==========================================================================

  /**
   * Create a new driver under a transporter
   */
  async createDriver(transporterId: string, data: CreateDriverInput & { licensePhoto?: string }): Promise<UserRecord> {
    // Check if driver with this phone already exists
    const existingResult = await db.getUserByPhone(data.phone, 'driver');
    const existing = existingResult && typeof (existingResult as any).then === 'function'
      ? await existingResult
      : existingResult;

    if (existing) {
      throw new AppError(400, 'DRIVER_EXISTS', 'A driver with this phone number already exists');
    }

    const driverResult = await db.createUser({
      id: uuid(),
      phone: data.phone,
      role: 'driver',
      name: data.name,
      email: data.email || undefined,
      transporterId: transporterId,
      licenseNumber: data.licenseNumber,
      licensePhoto: (data as any).licensePhoto || undefined,  // DL photo URL/base64
      isVerified: false,
      isActive: true
    });

    const driver = driverResult && typeof (driverResult as any).then === 'function'
      ? await driverResult
      : driverResult;

    logger.info(`Driver created: ${data.name} (${data.phone}) for transporter ${transporterId}`);

    // Get updated driver stats
    const driverStats = await this.getTransporterDrivers(transporterId);

    // Emit real-time update to transporter
    socketService.emitToUser(transporterId, 'driver_added', {
      driver: {
        id: driver.id,
        name: driver.name,
        phone: driver.phone,
        licenseNumber: driver.licenseNumber,
        isVerified: driver.isVerified
      },
      driverStats: {
        total: driverStats.total,
        available: driverStats.available,
        onTrip: driverStats.onTrip
      },
      message: `Driver ${data.name} added successfully`
    });

    logger.info(`📡 Real-time update sent: driver_added for transporter ${transporterId}`);

    return driver;
  }

  /**
   * Get all drivers for a transporter with stats
   */
  async getTransporterDrivers(transporterId: string): Promise<{
    drivers: UserRecord[];
    total: number;
    available: number;
    onTrip: number;
  }> {
    const drivers = await db.getDriversByTransporter(transporterId);

    // Get all vehicles to check which drivers are assigned
    const vehicles = await db.getVehiclesByTransporter(transporterId);
    const driversOnTrip = new Set(
      vehicles
        .filter(v => v.status === 'in_transit' && v.assignedDriverId)
        .map(v => v.assignedDriverId)
    );

    const activeDrivers = drivers.filter(d => d.isActive);
    const available = activeDrivers.filter(d => !driversOnTrip.has(d.id)).length;
    const onTrip = activeDrivers.filter(d => driversOnTrip.has(d.id)).length;

    return {
      drivers: activeDrivers,
      total: activeDrivers.length,
      available,
      onTrip
    };
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
        cancelledCount
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
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to get performance', {
        driverId,
        error: error.message,
        stack: error.stack?.substring(0, 300)
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
    } catch (err: any) {
      logger.warn('[DRIVER SERVICE] Dashboard acceptance rate failed, using default', {
        userId, error: err.message
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
        isOnline: await this.isDriverOnline(userId),
        lastOnline: null
      }
    };
  }

  // ==========================================================================
  // DRIVER ONLINE/OFFLINE PRESENCE SYSTEM (Production-Grade)
  // ==========================================================================
  // Two-State Model:
  //   A) Driver Intent (DB: isAvailable) — changes ONLY on button press
  //   B) Live Connectivity (Redis: driver:presence:{id} TTL 35s) — heartbeat
  //
  // Driver visible as ONLINE if: DB isAvailable=true AND Redis key exists
  // This prevents ghost-online (DB says online but driver app crashed)
  // ==========================================================================

  /**
   * Go Online — Driver presses "Go Online" button
   *
   * 1. Update DB: isAvailable = true (intent state)
   * 2. SET Redis presence with 35s TTL (connectivity state)
   * 3. SADD to transporter's onlineDrivers set
   * 4. Emit driver_status_changed to transporter via WebSocket
   * 5. Invalidate fleet cache
   */
  async goOnline(driverId: string): Promise<AvailabilityData> {
    try {
      logger.info('[DRIVER PRESENCE] Going ONLINE', { driverId });

      // 1. Update DB — intent state (only changes on button press)
      await prismaClient.user.update({
        where: { id: driverId },
        data: { isAvailable: true }
      });

      // 2. SET Redis presence — connectivity state
      const presenceData = JSON.stringify({
        driverId,
        onlineSince: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString()
      });
      await redisService.set(PRESENCE_KEY(driverId), presenceData, PRESENCE_TTL_SECONDS);

      // 3. SADD to transporter's online drivers set
      const driver = await prismaClient.user.findUnique({
        where: { id: driverId },
        select: { transporterId: true, name: true }
      });
      if (driver?.transporterId) {
        await redisService.sAdd(ONLINE_DRIVERS_KEY(driver.transporterId), driverId);

        // 4. Emit real-time status change to transporter
        socketService.emitToUser(driver.transporterId, 'driver_status_changed', {
          driverId,
          driverName: driver.name,
          isOnline: true,
          action: 'online',
          timestamp: new Date().toISOString()
        });

        // 5. Invalidate fleet cache so next list fetch shows updated status
        await fleetCacheService.invalidateDriverCache(driver.transporterId, driverId);
      }

      logger.info('[DRIVER PRESENCE] Driver is now ONLINE', { driverId });

      return {
        isOnline: true,
        currentLocation: undefined,
        lastUpdated: new Date().toISOString()
      };
    } catch (error: any) {
      logger.error('[DRIVER PRESENCE] Failed to go online', {
        driverId,
        error: error.message
      });
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to go online');
    }
  }

  /**
   * Go Offline — Driver presses "Go Offline" button
   *
   * 1. Update DB: isAvailable = false (intent state)
   * 2. DEL Redis presence key (immediate removal)
   * 3. SREM from transporter's onlineDrivers set
   * 4. Emit driver_status_changed to transporter via WebSocket
   * 5. Invalidate fleet cache
   */
  async goOffline(driverId: string): Promise<AvailabilityData> {
    try {
      logger.info('[DRIVER PRESENCE] Going OFFLINE', { driverId });

      // 1. Update DB — intent state
      await prismaClient.user.update({
        where: { id: driverId },
        data: { isAvailable: false }
      });

      // 2. DEL Redis presence — immediate removal
      await redisService.del(PRESENCE_KEY(driverId));

      // 3. SREM from transporter's online drivers set
      const driver = await prismaClient.user.findUnique({
        where: { id: driverId },
        select: { transporterId: true, name: true }
      });
      if (driver?.transporterId) {
        await redisService.sRem(ONLINE_DRIVERS_KEY(driver.transporterId), driverId);

        // 4. Emit real-time status change to transporter
        socketService.emitToUser(driver.transporterId, 'driver_status_changed', {
          driverId,
          driverName: driver.name,
          isOnline: false,
          action: 'offline',
          timestamp: new Date().toISOString()
        });

        // 5. Invalidate fleet cache
        await fleetCacheService.invalidateDriverCache(driver.transporterId, driverId);
      }

      logger.info('[DRIVER PRESENCE] Driver is now OFFLINE', { driverId });

      return {
        isOnline: false,
        currentLocation: undefined,
        lastUpdated: new Date().toISOString()
      };
    } catch (error: any) {
      logger.error('[DRIVER PRESENCE] Failed to go offline', {
        driverId,
        error: error.message
      });
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to go offline');
    }
  }

  /**
   * Handle Heartbeat — Driver app sends every 12 seconds
   *
   * ZERO DB WRITES — only extends Redis TTL.
   * If heartbeat stops → key expires after 35s → driver auto-offline.
   *
   * @param driverId - Driver's user ID
   * @param data - Heartbeat payload {lat, lng, battery, speed}
   */
  async handleHeartbeat(
    driverId: string,
    data: { lat?: number; lng?: number; battery?: number; speed?: number }
  ): Promise<void> {
    try {
      // SAFETY CHECK: Only extend presence if Redis key already exists.
      // This prevents ghost-online: if driver toggled OFF (DB + Redis cleared)
      // but a stale heartbeat arrives 500ms later, it would recreate the Redis
      // key and make the driver appear online again until TTL expires.
      //
      // With this guard:
      //   - Toggle OFF → goOffline() DELs Redis key → heartbeat arrives →
      //     key doesn't exist → heartbeat ignored → driver stays offline ✅
      //   - Normal online → heartbeat arrives → key exists → TTL extended ✅
      const existingPresence = await redisService.exists(PRESENCE_KEY(driverId));
      if (!existingPresence) {
        // No presence key — driver is offline, ignore stale heartbeat
        return;
      }

      // Extend Redis presence TTL — no DB write!
      const presenceData = JSON.stringify({
        driverId,
        lat: data.lat,
        lng: data.lng,
        battery: data.battery,
        speed: data.speed,
        lastHeartbeat: new Date().toISOString()
      });
      await redisService.set(PRESENCE_KEY(driverId), presenceData, PRESENCE_TTL_SECONDS);
    } catch (error: any) {
      // Non-critical — heartbeat failure shouldn't crash anything
      logger.warn('[DRIVER PRESENCE] Heartbeat failed', {
        driverId,
        error: error.message
      });
    }
  }

  /**
   * Restore Presence — Called when driver reconnects via WebSocket
   *
   * If DB isAvailable=true (driver pressed "Go Online" before disconnect),
   * restart Redis presence without requiring button press again.
   *
   * @param driverId - Driver's user ID
   */
  async restorePresence(driverId: string): Promise<boolean> {
    try {
      const driver = await prismaClient.user.findUnique({
        where: { id: driverId },
        select: { isAvailable: true, transporterId: true, name: true }
      });

      if (driver?.isAvailable && driver.transporterId) {
        // Restore Redis presence
        const presenceData = JSON.stringify({
          driverId,
          restored: true,
          lastHeartbeat: new Date().toISOString()
        });
        await redisService.set(PRESENCE_KEY(driverId), presenceData, PRESENCE_TTL_SECONDS);
        await redisService.sAdd(ONLINE_DRIVERS_KEY(driver.transporterId), driverId);

        // Best-effort: Notify transporter + invalidate cache (non-blocking)
        // THROTTLE: Only emit status event if not already emitted in last 10s
        // This prevents transporter UI spam when driver's network flaps
        const throttleKey = `driver:restore:throttle:${driverId}`;
        const alreadyEmitted = await redisService.get(throttleKey).catch(() => null);
        if (!alreadyEmitted) {
          await redisService.set(throttleKey, '1', 10).catch(() => { }); // 10s TTL
          socketService.emitToUser(driver.transporterId, 'driver_status_changed', {
            driverId,
            driverName: driver.name || '',
            isOnline: true,
            action: 'reconnected',
            timestamp: new Date().toISOString()
          });
          fleetCacheService.invalidateDriverCache(driver.transporterId, driverId).catch((e: any) => {
            logger.warn('[DRIVER PRESENCE] Fleet cache invalidation failed (non-critical)', { driverId, error: e.message });
          });
        } else {
          logger.debug('[DRIVER PRESENCE] Status emit throttled (duplicate reconnect within 10s)', { driverId });
        }

        logger.info('[DRIVER PRESENCE] Presence restored on reconnect', { driverId });
        return true;
      }
      return false;
    } catch (error: any) {
      logger.warn('[DRIVER PRESENCE] Failed to restore presence', {
        driverId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check if driver is truly online (DB intent + Redis connectivity)
   *
   * Driver is ONLINE if:
   *   DB isAvailable = true  AND  Redis presence key exists
   *
   * This prevents ghost-online (DB says online but driver crashed/disconnected).
   */
  async isDriverOnline(driverId: string): Promise<boolean> {
    try {
      const [dbUser, redisExists] = await Promise.all([
        prismaClient.user.findUnique({
          where: { id: driverId },
          select: { isAvailable: true }
        }),
        redisService.exists(PRESENCE_KEY(driverId))
      ]);

      return (dbUser?.isAvailable === true) && redisExists;
    } catch (error: any) {
      logger.warn('[DRIVER PRESENCE] isDriverOnline check failed', {
        driverId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get online driver IDs for a transporter
   *
   * Uses Redis SET for fast O(1) membership check.
   * Also verifies each driver's presence key still exists
   * (handles TTL expiry between SADD and SMEMBERS).
   */
  async getOnlineDriverIds(transporterId: string): Promise<string[]> {
    try {
      const memberIds = await redisService.sMembers(ONLINE_DRIVERS_KEY(transporterId));

      if (memberIds.length === 0) return [];

      // Verify each driver's presence key still exists (handles TTL expiry)
      const presenceChecks = await Promise.all(
        memberIds.map(async (id) => {
          const exists = await redisService.exists(PRESENCE_KEY(id));
          if (!exists) {
            // Stale entry — remove from set (auto-cleanup)
            await redisService.sRem(ONLINE_DRIVERS_KEY(transporterId), id);
          }
          return { id, online: exists };
        })
      );

      return presenceChecks.filter(p => p.online).map(p => p.id);
    } catch (error: any) {
      logger.warn('[DRIVER PRESENCE] Failed to get online drivers', {
        transporterId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get driver availability status (for driver's own dashboard)
   * 
   * Uses DB `isAvailable` as source of truth for the driver's intended state.
   * Redis presence is for transporter-facing real-time status (heartbeat-based).
   * 
   * WHY NOT Redis? Redis TTL is 35s. If heartbeat hasn't refreshed it yet
   * (e.g., app just toggled online, heartbeat starting), Redis may report false
   * even though the driver just pressed "Go Online". This causes the toggle
   * to snap back to offline on dashboard refresh — a terrible UX bug.
   * 
   * DB `isAvailable` is set immediately on toggle press and persists until
   * the driver explicitly presses "Go Offline". This is the correct source
   * of truth for the driver's own dashboard.
   */
  async getAvailability(userId: string): Promise<AvailabilityData> {
    try {
      const dbUser = await prismaClient.user.findUnique({
        where: { id: userId },
        select: { isAvailable: true }
      });

      const isOnline = dbUser?.isAvailable === true;

      return {
        isOnline,
        currentLocation: undefined,
        lastUpdated: new Date().toISOString()
      };
    } catch (error: any) {
      logger.warn('[DRIVER PRESENCE] getAvailability failed, falling back to false', {
        userId,
        error: error.message
      });
      return {
        isOnline: false,
        currentLocation: undefined,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  /**
   * Update driver availability — Production-Grade with Spam Protection
   * 
   * FLOW:
   *   1. Rate limit check (5s cooldown + 10/5min window) → O(1) Redis
   *   2. Idempotency check (skip if state unchanged) → 1 DB read
   *   3. Acquire distributed lock (prevent race conditions) → O(1) Redis SET NX
   *   4. If going OFFLINE: 1s debounce (cancel stale pending if going back ON)
   *   5. Execute state change (goOnline/goOffline)
   *   6. Set cooldown + release lock
   * 
   * SCALABILITY:
   *   - Rate limiter: O(1) Redis INCR → sub-1ms
   *   - Idempotency: 1 DB read (indexed PK) → sub-5ms
   *   - Lock: 1 Redis SET NX → sub-1ms
   *   - Total overhead: ~7ms per toggle
   *   - 10,000 drivers spamming → rate limiter stops 99%+ at Redis layer
   * 
   * SAFETY:
   *   - Explicitly checks `=== true` to avoid treating undefined/null as falsy
   *   - Lock auto-expires after 3s (no deadlocks)
   *   - All Redis failures gracefully degrade (toggle still works, just unprotected)
   */
  async updateAvailability(
    userId: string,
    data: { isOnline?: boolean; currentLocation?: { latitude: number; longitude: number } }
  ): Promise<AvailabilityData> {
    const requestedState = data.isOnline === true;

    // =========================================================================
    // STEP 1: Rate Limiting — Prevent toggle spam
    // =========================================================================
    try {
      // 1a. Cooldown check — min 5s between toggles
      const cooldownKey = TOGGLE_COOLDOWN_KEY(userId);
      const lastToggle = await redisService.get(cooldownKey);
      if (lastToggle) {
        const elapsed = Date.now() - parseInt(lastToggle, 10);
        const retryAfter = Math.ceil((TOGGLE_COOLDOWN_SECONDS * 1000 - elapsed) / 1000);
        if (retryAfter > 0) {
          logger.warn('[TOGGLE PROTECTION] Cooldown active — rejecting', {
            userId,
            retryAfterSeconds: retryAfter
          });
          throw new AppError(429, 'TOGGLE_RATE_LIMITED',
            `Please wait ${retryAfter} seconds before toggling again`);
        }
      }

      // 1b. Window limit — max 10 toggles per 5 minutes
      const countKey = TOGGLE_COUNT_KEY(userId);
      const rateCheck = await redisService.checkRateLimit(
        countKey,
        TOGGLE_MAX_PER_WINDOW,
        TOGGLE_WINDOW_SECONDS
      );
      if (!rateCheck.allowed) {
        logger.warn('[TOGGLE PROTECTION] Window limit exceeded — rejecting', {
          userId,
          remaining: rateCheck.remaining,
          resetIn: rateCheck.resetIn
        });
        throw new AppError(429, 'TOGGLE_RATE_LIMITED',
          `Too many toggles. Please wait ${rateCheck.resetIn} seconds.`);
      }
    } catch (error: any) {
      // If it's our rate limit error, rethrow. Otherwise graceful degrade.
      if (error instanceof AppError && error.statusCode === 429) {
        throw error;
      }
      logger.warn('[TOGGLE PROTECTION] Rate limit check failed, proceeding without protection', {
        userId,
        error: error.message
      });
    }

    // =========================================================================
    // STEP 2: Idempotency Check — Skip if state is already the same
    // =========================================================================
    try {
      const dbUser = await prismaClient.user.findUnique({
        where: { id: userId },
        select: { isAvailable: true }
      });

      const currentState = dbUser?.isAvailable === true;

      if (currentState === requestedState) {
        logger.info('[TOGGLE PROTECTION] Idempotent — no state change needed', {
          userId,
          currentState,
          requestedState
        });
        // Return current state immediately — no DB write, no Redis operations
        return {
          isOnline: currentState,
          currentLocation: undefined,
          lastUpdated: new Date().toISOString()
        };
      }
    } catch (error: any) {
      // DB read failed — proceed with toggle (better to double-write than block)
      logger.warn('[TOGGLE PROTECTION] Idempotency check failed, proceeding', {
        userId,
        error: error.message
      });
    }

    // =========================================================================
    // STEP 3: Distributed Lock — Prevent race conditions from double-taps
    // =========================================================================
    const lockKey = TOGGLE_LOCK_KEY(userId);
    let lockAcquired = false;

    try {
      const lockResult = await redisService.acquireLock(lockKey, userId, TOGGLE_LOCK_TTL_SECONDS);
      lockAcquired = lockResult.acquired;

      if (!lockAcquired) {
        logger.warn('[TOGGLE PROTECTION] Lock already held — rejecting concurrent toggle', {
          userId
        });
        throw new AppError(409, 'TOGGLE_IN_PROGRESS',
          'Toggle already in progress. Please wait.');
      }
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      // Redis lock failed — proceed without lock (graceful degradation)
      logger.warn('[TOGGLE PROTECTION] Lock acquisition failed, proceeding without lock', {
        userId,
        error: error.message
      });
    }

    try {
      // =====================================================================
      // STEP 4: Execute State Change
      // =====================================================================
      // NOTE: Offline debounce was REMOVED — it caused a critical bug where
      // redisService.get(pendingKey).catch(() => null) returned null on any
      // Redis latency/blip, treating it as "cancelled" and returning isOnline:true
      // without ever calling goOffline(). The Captain app already has a 2-second
      // isToggling cooldown that prevents accidental taps, making the backend
      // debounce redundant and harmful.
      // =====================================================================
      let result: AvailabilityData;

      if (requestedState) {
        result = await this.goOnline(userId);
      } else {
        result = await this.goOffline(userId);
      }

      // =====================================================================
      // STEP 6: Set Cooldown Timestamp
      // =====================================================================
      try {
        await redisService.set(
          TOGGLE_COOLDOWN_KEY(userId),
          Date.now().toString(),
          TOGGLE_COOLDOWN_SECONDS
        );
      } catch (error: any) {
        // Non-critical — cooldown not set, but toggle succeeded
        logger.warn('[TOGGLE PROTECTION] Failed to set cooldown', {
          userId,
          error: error.message
        });
      }

      return result;
    } finally {
      // =====================================================================
      // STEP 7: Release Lock (always, even on error)
      // =====================================================================
      if (lockAcquired) {
        try {
          await redisService.releaseLock(lockKey, userId);
        } catch (error: any) {
          logger.warn('[TOGGLE PROTECTION] Failed to release lock (will auto-expire)', {
            userId,
            error: error.message
          });
        }
      }
    }
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
        phone: activeTrip.customerPhone
      },
      createdAt: activeTrip.createdAt
    };
  }

  /**
   * Complete driver profile with photos and details
   * 
   * @param driverId - Driver's user ID
   * @param profileData - Profile completion data
   * @returns Updated driver record
   */
  async completeProfile(
    driverId: string,
    profileData: {
      licenseNumber: string;
      vehicleType: string;
      address: string;
      language: string;
      driverPhotoUrl: string;
      licenseFrontUrl: string;
      licenseBackUrl: string;
      isProfileCompleted: boolean;
    }
  ): Promise<UserRecord> {
    try {
      logger.info('[DRIVER SERVICE] Completing driver profile', { driverId });

      // Update driver in database using db.updateUser wrapper
      const driver = await db.updateUser(driverId, {
        licenseNumber: profileData.licenseNumber,
        preferredVehicleType: profileData.vehicleType,
        address: profileData.address,
        preferredLanguage: profileData.language,
        profilePhoto: profileData.driverPhotoUrl,
        licenseFrontPhoto: profileData.licenseFrontUrl,
        licenseBackPhoto: profileData.licenseBackUrl,
        isProfileCompleted: profileData.isProfileCompleted
      });

      if (!driver) {
        throw new Error('Driver not found');
      }

      // Invalidate cache
      await fleetCacheService.invalidateDriverCache(driverId);

      logger.info('[DRIVER SERVICE] Profile completed successfully', {
        driverId,
        licenseNumber: profileData.licenseNumber
      });

      return driver;
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to complete profile', {
        driverId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * =============================================================================
   * PROFILE PHOTO MANAGEMENT METHODS
   * =============================================================================
   * Scalable, modular methods for updating driver photos
   * Easy to understand, follows coding standards
   * =============================================================================
   */

  /**
   * Get driver by ID
   * 
   * @param driverId - Driver's user ID
   * @returns Driver record with all details
   */
  async getDriverById(driverId: string): Promise<UserRecord | null> {
    try {
      logger.info('[DRIVER SERVICE] Getting driver', { driverId });

      // Use db.getUserById wrapper method
      const driver = await db.getUserById(driverId);

      if (!driver) {
        logger.warn('[DRIVER SERVICE] Driver not found', { driverId });
        return null;
      }

      // Verify it's a driver role
      if (driver.role !== 'driver') {
        logger.warn('[DRIVER SERVICE] User is not a driver', { driverId, role: driver.role });
        return null;
      }

      logger.info('[DRIVER SERVICE] Driver retrieved successfully', {
        driverId,
        hasProfile: !!driver.profilePhoto
      });

      return driver;
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to get driver', {
        driverId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update profile photo
   * 
   * @param driverId - Driver's user ID
   * @param photoUrl - New profile photo URL (S3)
   * @returns Updated driver record
   */
  async updateProfilePhoto(
    driverId: string,
    photoUrl: string
  ): Promise<UserRecord> {
    try {
      logger.info('[DRIVER SERVICE] Updating profile photo', { driverId });

      // Use db.updateUser wrapper method
      const driver = await db.updateUser(driverId, {
        profilePhoto: photoUrl
      });

      if (!driver) {
        throw new Error('Driver not found');
      }

      // Invalidate cache for real-time updates
      await fleetCacheService.invalidateDriverCache(driverId);

      logger.info('[DRIVER SERVICE] Profile photo updated', { driverId });

      return driver;
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to update profile photo', {
        driverId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update license photos (front and/or back)
   * 
   * @param driverId - Driver's user ID
   * @param licenseFrontUrl - New license front URL (optional)
   * @param licenseBackUrl - New license back URL (optional)
   * @returns Updated driver record
   */
  async updateLicensePhotos(
    driverId: string,
    licenseFrontUrl?: string,
    licenseBackUrl?: string
  ): Promise<UserRecord> {
    try {
      logger.info('[DRIVER SERVICE] Updating license photos', { driverId });

      // Build update data dynamically
      const updateData: any = {};

      if (licenseFrontUrl) {
        updateData.licenseFrontPhoto = licenseFrontUrl;
      }

      if (licenseBackUrl) {
        updateData.licenseBackPhoto = licenseBackUrl;
      }

      // Use db.updateUser wrapper method
      const driver = await db.updateUser(driverId, updateData);

      if (!driver) {
        throw new Error('Driver not found');
      }

      // Invalidate cache for real-time updates
      await fleetCacheService.invalidateDriverCache(driverId);

      logger.info('[DRIVER SERVICE] License photos updated', { driverId });

      return driver;
    } catch (error: any) {
      logger.error('[DRIVER SERVICE] Failed to update license photos', {
        driverId,
        error: error.message
      });
      throw error;
    }
  }
}

export const driverService = new DriverService();
