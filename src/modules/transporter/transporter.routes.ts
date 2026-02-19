/**
 * =============================================================================
 * TRANSPORTER ROUTES - API for transporter operations
 * =============================================================================
 * 
 * ENDPOINTS:
 * - PUT  /api/v1/transporter/availability   - Update online/offline status
 * - GET  /api/v1/transporter/availability   - Get current availability status
 * - GET  /api/v1/transporter/profile        - Get transporter profile
 * - PUT  /api/v1/transporter/profile        - Update transporter profile
 * - GET  /api/v1/transporter/stats          - Get transporter statistics
 * 
 * AVAILABILITY FEATURE:
 * - When transporter is OFFLINE, they won't receive broadcasts
 * - Even if their vehicles match the request
 * - Used for breaks, end of day, etc.
 * 
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { db } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { cacheService } from '../../shared/services/cache.service';
import { redisService } from '../../shared/services/redis.service';
import { emitToUser } from '../../shared/services/socket.service';
import { availabilityService } from '../../shared/services/availability.service';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { bookingService } from '../booking/booking.service';

const router = Router();

// =============================================================================
// REDIS KEY PATTERNS — Transporter Online/Offline Toggle Protection
// =============================================================================
// Mirrors the driver toggle protection from driver.service.ts.
// All operations are O(1) Redis commands — handles millions of transporters.
//
// FLOW:
//   1. Check rate limit (cooldown + window)
//   2. Check idempotency (skip if state unchanged)
//   3. Acquire distributed lock (prevent race conditions)
//   4. Execute state change (DB + Redis presence + online set + cache)
//   5. Set cooldown + release lock
// =============================================================================
import {
  ONLINE_TRANSPORTERS_SET,
  TRANSPORTER_PRESENCE_KEY,
  PRESENCE_TTL_SECONDS as SHARED_PRESENCE_TTL_SECONDS
} from '../../shared/services/transporter-online.service';

const TRANSPORTER_TOGGLE_COOLDOWN_KEY = (id: string) => `transporter:toggle:cooldown:${id}`;
const TRANSPORTER_TOGGLE_COUNT_KEY = (id: string) => `transporter:toggle:count:${id}`;
const TRANSPORTER_TOGGLE_LOCK_KEY = (id: string) => `transporter:toggle:lock:${id}`;

const TOGGLE_COOLDOWN_SECONDS = 5;        // Min 5s between toggles
const TOGGLE_MAX_PER_WINDOW = 10;          // Max 10 toggles per window
const TOGGLE_WINDOW_SECONDS = 300;         // 5-minute window
const TOGGLE_LOCK_TTL_SECONDS = 5;         // Lock TTL for processing

// =============================================================================
// AVAILABILITY ENDPOINTS
// =============================================================================

/**
 * PUT /api/v1/transporter/availability
 * Update transporter's online/offline status
 * 
 * Production-grade with spam protection:
 *   Step 1: Rate limit (5s cooldown + 10/5min window)
 *   Step 2: Idempotency (skip if state unchanged)
 *   Step 3: Distributed lock (prevent race conditions)
 *   Step 4: Execute state change (DB + Redis + cache)
 *   Step 5: Set cooldown
 *   Step 6: Release lock
 * 
 * Body: { isAvailable: boolean }
 */
router.put(
  '/availability',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    const transporterId = user.userId;
    const { isAvailable } = req.body;

    // =====================================================================
    // VALIDATION
    // =====================================================================
    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'isAvailable must be a boolean'
        }
      });
    }

    const requestedState = isAvailable === true;

    // =====================================================================
    // STEP 1: Idempotency Check — Skip if state is already the same
    // Done BEFORE rate limiting so idempotent calls don't eat the budget.
    // A transporter's app may send isAvailable:true on every resume —
    // these should return 200 instantly without counting as a toggle.
    // =====================================================================
    try {
      const dbUser = await prismaClient.user.findUnique({
        where: { id: transporterId },
        select: { isAvailable: true }
      });

      if (!dbUser) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Transporter not found'
          }
        });
      }

      const currentState = dbUser.isAvailable === true; // null/undefined = OFFLINE (safe default)
      if (currentState === requestedState) {
        logger.info('[TRANSPORTER TOGGLE] Idempotent — no state change needed', {
          transporterId,
          currentState,
          requestedState
        });
        return res.json({
          success: true,
          data: {
            isAvailable: currentState,
            updatedAt: new Date().toISOString(),
            cooldownMs: 0,
            idempotent: true
          }
        });
      }
    } catch (error: any) {
      // DB read failed — proceed with toggle (better to double-write than block)
      logger.warn('[TRANSPORTER TOGGLE] Idempotency check failed, proceeding', {
        transporterId,
        error: error.message
      });
    }

    // =====================================================================
    // STEP 2: Rate Limiting — Prevent toggle spam
    // Only reached for ACTUAL state changes (idempotent calls skipped above).
    // =====================================================================
    try {
      // 2a. Cooldown check — min 5s between toggles
      const cooldownKey = TRANSPORTER_TOGGLE_COOLDOWN_KEY(transporterId);
      const lastToggle = await redisService.get(cooldownKey);
      if (lastToggle) {
        const elapsed = Date.now() - parseInt(lastToggle, 10);
        const retryAfterMs = Math.max(0, TOGGLE_COOLDOWN_SECONDS * 1000 - elapsed);
        if (retryAfterMs > 0) {
          logger.warn('[TRANSPORTER TOGGLE] Cooldown active — rejecting', {
            transporterId,
            retryAfterMs
          });
          return res.status(429).json({
            success: false,
            error: {
              code: 'TOGGLE_RATE_LIMITED',
              message: `Please wait before toggling again`,
              retryAfterMs
            }
          });
        }
      }

      // 2b. Window limit — max 10 toggles per 5 minutes
      const countKey = TRANSPORTER_TOGGLE_COUNT_KEY(transporterId);
      const rateCheck = await redisService.checkRateLimit(
        countKey,
        TOGGLE_MAX_PER_WINDOW,
        TOGGLE_WINDOW_SECONDS
      );
      if (!rateCheck.allowed) {
        logger.warn('[TRANSPORTER TOGGLE] Window limit exceeded — rejecting', {
          transporterId,
          remaining: rateCheck.remaining,
          resetIn: rateCheck.resetIn
        });
        return res.status(429).json({
          success: false,
          error: {
            code: 'TOGGLE_RATE_LIMITED',
            message: `Too many toggles. Please wait ${rateCheck.resetIn} seconds.`,
            retryAfterMs: rateCheck.resetIn * 1000
          }
        });
      }
    } catch (error: any) {
      // Graceful degradation — if Redis is down, proceed without rate limiting
      logger.warn('[TRANSPORTER TOGGLE] Rate limit check failed, proceeding unprotected', {
        transporterId,
        error: error.message
      });
    }

    // =====================================================================
    // STEP 3: Distributed Lock — Prevent race conditions
    // =====================================================================
    const lockKey = TRANSPORTER_TOGGLE_LOCK_KEY(transporterId);
    let lockAcquired = false;

    try {
      const lockResult = await redisService.acquireLock(lockKey, transporterId, TOGGLE_LOCK_TTL_SECONDS);
      lockAcquired = lockResult.acquired;

      if (!lockAcquired) {
        logger.warn('[TRANSPORTER TOGGLE] Lock already held — rejecting', { transporterId });
        return res.status(409).json({
          success: false,
          error: {
            code: 'TOGGLE_IN_PROGRESS',
            message: 'Toggle already in progress. Please wait.',
            retryAfterMs: 2000
          }
        });
      }
    } catch (error: any) {
      // Graceful degradation — proceed without lock
      logger.warn('[TRANSPORTER TOGGLE] Lock acquisition failed, proceeding without lock', {
        transporterId,
        error: error.message
      });
    }

    try {
      // ===================================================================
      // STEP 4: Execute State Change
      // ===================================================================

      // 4a. Update DB — source of truth
      // Note: updatedAt is auto-managed by Prisma @updatedAt
      await prismaClient.user.update({
        where: { id: transporterId },
        data: {
          isAvailable: requestedState
        }
      });

      // 4b. Update Redis presence key
      if (requestedState) {
        // ONLINE: Set presence key with TTL
        const presenceData = JSON.stringify({
          transporterId,
          onlineSince: new Date().toISOString()
        });
        await redisService.set(TRANSPORTER_PRESENCE_KEY(transporterId), presenceData, SHARED_PRESENCE_TTL_SECONDS).catch((e: any) => {
          logger.warn('[TRANSPORTER TOGGLE] Failed to set Redis presence', { transporterId, error: e.message });
        });

        // Add to online transporters set
        await redisService.sAdd(ONLINE_TRANSPORTERS_SET, transporterId).catch((e: any) => {
          logger.warn('[TRANSPORTER TOGGLE] Failed to SADD online set', { transporterId, error: e.message });
        });
      } else {
        // OFFLINE: Delete presence key immediately
        await redisService.del(TRANSPORTER_PRESENCE_KEY(transporterId)).catch((e: any) => {
          logger.warn('[TRANSPORTER TOGGLE] Failed to DEL Redis presence', { transporterId, error: e.message });
        });

        // Remove from online transporters set
        await redisService.sRem(ONLINE_TRANSPORTERS_SET, transporterId).catch((e: any) => {
          logger.warn('[TRANSPORTER TOGGLE] Failed to SREM online set', { transporterId, error: e.message });
        });
      }

      // 4c. Invalidate caches (batch — faster than serial)
      try {
        const vehicles = await db.getVehiclesByTransporter(transporterId);
        const vehicleTypes = new Set(vehicles.map(v => v.vehicleType));

        await Promise.all([
          cacheService.delete(`user:${transporterId}`),
          ...Array.from(vehicleTypes).map(type => cacheService.delete(`trans:vehicle:${type}:*`))
        ]);
      } catch (cacheError: any) {
        // Non-critical — cache will expire naturally
        logger.warn('[TRANSPORTER TOGGLE] Cache invalidation failed', {
          transporterId,
          error: cacheError.message
        });
      }

      // 4d. WebSocket broadcast — real-time update for dashboards
      // PRD Section 4.1.6: Emit transporter_status_changed so dashboards update in real-time
      try {
        emitToUser(transporterId, 'transporter_status_changed', {
          transporterId,
          isAvailable: requestedState,
          updatedAt: new Date().toISOString()
        });
      } catch (wsError: any) {
        // Best-effort — toggle still succeeds if broadcast fails (Edge Case #8)
        logger.warn('[TRANSPORTER TOGGLE] WebSocket broadcast failed', {
          transporterId,
          error: wsError.message
        });
      }

      logger.info(`📢 Transporter ${transporterId} is now ${requestedState ? 'ONLINE ✅' : 'OFFLINE ❌'}`);

      // ===================================================================
      // STEP 4e: Re-Broadcast — Deliver missed bookings to newly-online transporter
      // Fire-and-forget: does NOT block toggle response
      // ===================================================================
      if (requestedState) {
        bookingService.deliverMissedBroadcasts(transporterId).catch((err: any) => {
          logger.warn('[TRANSPORTER TOGGLE] Re-broadcast failed (non-critical)', {
            transporterId,
            error: err.message
          });
        });
      }

      // ===================================================================
      // STEP 5: Set Cooldown Timestamp
      // ===================================================================
      try {
        await redisService.set(
          TRANSPORTER_TOGGLE_COOLDOWN_KEY(transporterId),
          Date.now().toString(),
          TOGGLE_COOLDOWN_SECONDS
        );
      } catch (error: any) {
        // Non-critical
        logger.warn('[TRANSPORTER TOGGLE] Failed to set cooldown', {
          transporterId,
          error: error.message
        });
      }

      // Success response
      res.json({
        success: true,
        data: {
          isAvailable: requestedState,
          updatedAt: new Date().toISOString(),
          cooldownMs: TOGGLE_COOLDOWN_SECONDS * 1000
        }
      });

    } catch (error: any) {
      logger.error(`[TRANSPORTER TOGGLE] State change failed: ${error.message}`, {
        transporterId,
        requestedState
      });
      next(error);

    } finally {
      // ===================================================================
      // STEP 6: Release Lock (always, even on error)
      // ===================================================================
      if (lockAcquired) {
        try {
          await redisService.releaseLock(lockKey, transporterId);
        } catch (error: any) {
          logger.warn('[TRANSPORTER TOGGLE] Failed to release lock (will auto-expire)', {
            transporterId,
            error: error.message
          });
        }
      }
    }
  }
);

/**
 * GET /api/v1/transporter/availability
 * Get transporter's current availability status
 * 
 * Also returns cooldown info so the app can disable the toggle button
 * for the remaining cooldown period.
 */
router.get(
  '/availability',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const transporterId = user.userId;

      const transporter = await prismaClient.user.findUnique({
        where: { id: transporterId },
        select: { isAvailable: true, updatedAt: true }
      });

      if (!transporter) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Transporter not found'
          }
        });
      }

      // Check remaining cooldown so app can disable toggle button
      let cooldownRemainingMs = 0;
      try {
        const lastToggle = await redisService.get(TRANSPORTER_TOGGLE_COOLDOWN_KEY(transporterId));
        if (lastToggle) {
          const elapsed = Date.now() - parseInt(lastToggle, 10);
          cooldownRemainingMs = Math.max(0, TOGGLE_COOLDOWN_SECONDS * 1000 - elapsed);
        }
      } catch (_) {
        // Non-critical — cooldown unknown, assume 0
      }

      res.json({
        success: true,
        data: {
          isAvailable: transporter.isAvailable === true, // null/undefined = OFFLINE (safe default)
          updatedAt: transporter.updatedAt,
          cooldownRemainingMs
        }
      });

    } catch (error: any) {
      logger.error(`Get availability error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * POST /api/v1/transporter/heartbeat
 * Update transporter's live location and availability
 * 
 * CALL THIS EVERY 5 SECONDS from the Captain app
 * 
 * This powers the LIVE AVAILABILITY TABLE for proximity-based matching:
 * - Geohash-indexed for fast nearby searches
 * - Stale entries (>60 sec) auto-removed
 * - Used to find top 10 nearby transporters for batch notify
 * 
 * Body: {
 *   latitude: number,
 *   longitude: number,
 *   vehicleId?: string,    // Currently active vehicle (optional)
 *   isOnTrip?: boolean     // Whether currently on a trip
 * }
 */
router.post(
  '/heartbeat',
  authMiddleware,
  roleGuard(['transporter', 'driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { latitude, longitude, vehicleId, isOnTrip } = req.body;

      // Validate coordinates
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'latitude and longitude are required numbers'
          }
        });
        return;
      }

      // Get transporter's vehicles to determine vehicleKey
      const vehicles = await db.getVehiclesByTransporter(user.userId);

      if (vehicles.length === 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_VEHICLES',
            message: 'No vehicles registered. Register a vehicle first.'
          }
        });
        return;
      }

      // Use specified vehicle or first available
      const vehicle = vehicleId
        ? vehicles.find(v => v.id === vehicleId)
        : vehicles.find(v => v.isActive && v.status === 'available') || vehicles[0];

      if (!vehicle) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VEHICLE_NOT_FOUND',
            message: 'Specified vehicle not found'
          }
        });
        return;
      }

      // Generate vehicle key if not present (legacy vehicle)
      const vehicleKey = vehicle.vehicleKey || generateVehicleKey(vehicle.vehicleType, vehicle.vehicleSubtype);

      // Update availability service (geohash-indexed)
      availabilityService.updateAvailability({
        transporterId: user.userId,
        driverId: user.role === 'driver' ? user.userId : undefined,
        vehicleKey,
        vehicleId: vehicle.id,
        latitude,
        longitude,
        isOnTrip: isOnTrip || false
      });

      // =====================================================================
      // REFRESH TRANSPORTER PRESENCE KEY (Toggle-based online tracking)
      // =====================================================================
      // The availability service above handles geo-based tracking.
      // This refreshes the separate transporter:presence:{id} key used by
      // broadcast filtering (online:transporters set).
      //
      // GUARD: Only refresh if presence key exists — prevents ghost-online
      // after toggle OFF. Same pattern as driver.service.ts handleHeartbeat().
      // =====================================================================
      try {
        const presenceExists = await redisService.exists(TRANSPORTER_PRESENCE_KEY(user.userId));
        if (presenceExists) {
          const presenceData = JSON.stringify({
            transporterId: user.userId,
            lastHeartbeat: new Date().toISOString(),
            latitude,
            longitude
          });
          await redisService.set(
            TRANSPORTER_PRESENCE_KEY(user.userId),
            presenceData,
            SHARED_PRESENCE_TTL_SECONDS
          );
        }
      } catch (presenceError: any) {
        // Non-critical — don't fail the heartbeat response
        logger.warn('[TRANSPORTER HEARTBEAT] Presence refresh failed', {
          userId: user.userId,
          error: presenceError.message
        });
      }

      res.json({
        success: true,
        data: {
          registered: true,
          vehicleKey,
          vehicleId: vehicle.id,
          isOnTrip: isOnTrip || false,
          nextHeartbeatMs: availabilityService.HEARTBEAT_INTERVAL_MS
        }
      });

    } catch (error: any) {
      logger.error(`Heartbeat error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/transporter/heartbeat
 * Mark transporter as offline (remove from availability)
 * 
 * Call this when:
 * - App goes to background
 * - User logs out
 * - User toggles offline
 */
router.delete(
  '/heartbeat',
  authMiddleware,
  roleGuard(['transporter', 'driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      // Remove from availability service
      availabilityService.setOffline(user.userId);

      logger.info(`📴 Transporter ${user.userId} went offline`);

      res.json({
        success: true,
        data: {
          offline: true,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error: any) {
      logger.error(`Offline error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * GET /api/v1/transporter/availability/stats
 * Get live availability statistics (for admin/debugging)
 */
router.get(
  '/availability/stats',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = availabilityService.getStats();

      res.json({
        success: true,
        data: stats
      });

    } catch (error: any) {
      logger.error(`Availability stats error: ${error.message}`);
      next(error);
    }
  }
);

// =============================================================================
// PROFILE ENDPOINTS
// =============================================================================

/**
 * GET /api/v1/transporter/profile
 * Get transporter profile with stats
 */
router.get(
  '/profile',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      const transporter = await db.getUserById(user.userId);

      if (!transporter) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Transporter not found'
          }
        });
      }

      // Get vehicles count
      const vehicles = await db.getVehiclesByTransporter(user.userId);
      const drivers = await db.getDriversByTransporter(user.userId);

      res.json({
        success: true,
        data: {
          profile: {
            id: transporter.id,
            name: transporter.name,
            businessName: transporter.businessName,
            phone: transporter.phone,
            email: transporter.email,
            gstNumber: transporter.gstNumber,
            isAvailable: transporter.isAvailable === true, // null/undefined = OFFLINE (safe default)
            createdAt: transporter.createdAt
          },
          stats: {
            vehiclesCount: vehicles.length,
            driversCount: drivers.length,
            availableVehicles: vehicles.filter(v => v.status === 'available').length,
            activeTrips: vehicles.filter(v => v.status === 'in_transit').length
          }
        }
      });

    } catch (error: any) {
      logger.error(`Get profile error: ${error.message}`);
      next(error);
    }
  }
);

/**
 * PUT /api/v1/transporter/profile
 * Update transporter profile
 */
router.put(
  '/profile',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { name, businessName, email, gstNumber } = req.body;

      const updates: any = {};
      if (name) updates.name = name;
      if (businessName) updates.businessName = businessName;
      if (email) updates.email = email;
      if (gstNumber) updates.gstNumber = gstNumber;

      await db.updateUser(user.userId, updates);

      // Invalidate cache
      await cacheService.delete(`user:${user.userId}`);

      const updated = await db.getUserById(user.userId);

      logger.info(`Transporter ${user.userId} profile updated`);

      res.json({
        success: true,
        data: {
          profile: {
            id: updated?.id,
            name: updated?.name,
            businessName: updated?.businessName,
            phone: updated?.phone,
            email: updated?.email,
            gstNumber: updated?.gstNumber
          }
        }
      });

    } catch (error: any) {
      logger.error(`Update profile error: ${error.message}`);
      next(error);
    }
  }
);

// =============================================================================
// STATS ENDPOINTS
// =============================================================================

/**
 * GET /api/v1/transporter/stats
 * Get transporter statistics (earnings, trips, etc.)
 */
router.get(
  '/stats',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const transporterId = user.userId;

      // =====================================================================
      // PRODUCTION-GRADE: Use indexed COUNT + AGGREGATE queries
      // instead of fetching all assignments into memory.
      // All queries use @@index([transporterId]) and @@index([transporterId, status])
      // =====================================================================
      const [
        totalTrips,
        completedTrips,
        activeTrips,
        earningsResult,
        ratingResult
      ] = await Promise.all([
        // Total assignments for this transporter
        prismaClient.assignment.count({ where: { transporterId } }),
        // Completed trips
        prismaClient.assignment.count({ where: { transporterId, status: 'completed' } }),
        // Active trips (pending + in_progress + driver_accepted + en_route_pickup + at_pickup + in_transit)
        prismaClient.assignment.count({
          where: {
            transporterId,
            status: { in: ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] }
          }
        }),
        // Total earnings from completed bookings (sum of pricePerTruck)
        prismaClient.assignment.findMany({
          where: { transporterId, status: 'completed', bookingId: { not: null } },
          select: { bookingId: true },
          distinct: ['bookingId']
        }).then(async (assignments) => {
          if (assignments.length === 0) return 0;
          const bookingIds = assignments.map(a => a.bookingId).filter((id): id is string => id !== null);
          if (bookingIds.length === 0) return 0;
          const result = await prismaClient.booking.aggregate({
            where: { id: { in: bookingIds } },
            _sum: { pricePerTruck: true }
          });
          return result._sum.pricePerTruck || 0;
        }),
        // Average rating from ratings received by this transporter's drivers
        prismaClient.rating.aggregate({
          where: {
            driver: { transporterId }
          },
          _avg: { stars: true },
          _count: { stars: true }
        })
      ]);

      const declinedTrips = await prismaClient.assignment.count({
        where: { transporterId, status: 'driver_declined' }
      });

      const acceptanceRate = totalTrips > 0
        ? Math.round(((totalTrips - declinedTrips) / totalTrips) * 100)
        : 100;

      const rating = ratingResult._avg.stars
        ? Math.round(ratingResult._avg.stars * 10) / 10
        : 0;

      res.json({
        success: true,
        data: {
          totalTrips,
          completedTrips,
          activeTrips,
          totalEarnings: earningsResult,
          rating,
          totalRatings: ratingResult._count.stars || 0,
          acceptanceRate
        }
      });

    } catch (error: any) {
      logger.error(`Get stats error: ${error.message}`);
      next(error);
    }
  }
);

export default router;
