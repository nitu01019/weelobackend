/**
 * =============================================================================
 * DRIVER MODULE - PRESENCE SERVICE
 * =============================================================================
 *
 * Online/offline presence system, heartbeat handling, toggle spam protection,
 * and availability status management.
 * =============================================================================
 */

import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';
import { fleetCacheService } from '../../shared/services/fleet-cache.service';
import { redisService } from '../../shared/services/redis.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { AvailabilityData } from './driver.types';
import { getErrorMessage } from '../../shared/utils/error.utils';
import { DRIVER_PRESENCE_TTL_SECONDS as PRESENCE_TTL_SECONDS } from '../../shared/config/presence.config';

// =============================================================================
// REDIS KEY PATTERNS — Driver Online/Offline Presence System
// =============================================================================
// driver:presence:{driverId}                → SET with TTL from presence.config (F-B-05)
// transporter:{transporterId}:onlineDrivers → SET of online driverIds
//
// TTL DESIGN:
//   Heartbeat interval = 12 seconds (HEARTBEAT_INTERVAL_SECONDS)
//   Redis TTL          = 36 seconds (DRIVER_PRESENCE_TTL_SECONDS = 3× heartbeat)
//   → 3 retry windows before auto-offline
//   → Handles 4G instability / network jitter
//
// ZERO DB WRITES for heartbeat — only Redis SET with TTL extension
// DB writes ONLY on manual button press (isAvailable = true/false)
// =============================================================================
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

class DriverPresenceService {

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
      // Compensating transaction: rollback DB if Redis fails
      // Industry pattern (Grab): multi-store writes with compensation
      try {
        await redisService.set(PRESENCE_KEY(driverId), presenceData, PRESENCE_TTL_SECONDS);
      } catch (redisErr: unknown) {
        logger.error('[DRIVER PRESENCE] Redis SET failed — rolling back DB', {
          driverId, error: getErrorMessage(redisErr)
        });
        await prismaClient.user.update({
          where: { id: driverId },
          data: { isAvailable: false }
        }).catch((err) => { logger.warn('[DriverPresence] DB rollback failed after Redis SET failure', { driverId, error: err instanceof Error ? err.message : String(err) }); });
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to go online. Please try again.');
      }

      // 3. SADD to transporter's online drivers set + notify transporter
      // Best-effort: if these fail, driver is still online (DB+Redis correct).
      // Transporter sees the update on next heartbeat/fleet refresh.
      const driver = await prismaClient.user.findUnique({
        where: { id: driverId },
        select: { transporterId: true, name: true }
      });
      if (driver?.transporterId) {
        try {
          await redisService.sAdd(ONLINE_DRIVERS_KEY(driver.transporterId), driverId);
        } catch (sAddErr: unknown) {
          logger.warn('[DRIVER PRESENCE] SADD failed (best-effort, driver still online)', {
            driverId, error: getErrorMessage(sAddErr)
          });
        }

        // 4. Emit real-time status change to transporter (fire-and-forget)
        socketService.emitToUser(driver.transporterId, 'driver_status_changed', {
          driverId,
          driverName: driver.name,
          isOnline: true,
          action: 'online',
          timestamp: new Date().toISOString()
        });

        // 5. Invalidate fleet cache so next list fetch shows updated status
        await fleetCacheService.invalidateDriverCache(driver.transporterId, driverId).catch(() => {});
      }

      logger.info('[DRIVER PRESENCE] Driver is now ONLINE', { driverId });

      return {
        isOnline: true,
        currentLocation: undefined,
        lastUpdated: new Date().toISOString()
      };
    } catch (error: unknown) {
      logger.error('[DRIVER PRESENCE] Failed to go online', {
        driverId,
        error: getErrorMessage(error)
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
    } catch (error: unknown) {
      logger.error('[DRIVER PRESENCE] Failed to go offline', {
        driverId,
        error: getErrorMessage(error)
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
      // FIX-36: Validate GPS coordinates before processing
      const { lat, lng } = data;
      if (lat != null || lng != null) {
        if (
          typeof lat !== 'number' || typeof lng !== 'number' ||
          !isFinite(lat) || !isFinite(lng) ||
          lat < -90 || lat > 90 ||
          lng < -180 || lng > 180
        ) {
          logger.warn('[Presence] Invalid GPS coordinates rejected', {
            driverId, lat, lng
          });
          return;
        }
      }

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
    } catch (error: unknown) {
      // Non-critical — heartbeat failure shouldn't crash anything
      logger.warn('[DRIVER PRESENCE] Heartbeat failed', {
        driverId,
        error: getErrorMessage(error)
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
        select: { isAvailable: true, transporterId: true, name: true, updatedAt: true }
      });

      if (driver?.isAvailable && driver.transporterId) {
        // H17 FIX: Only auto-restore if driver was online within 15 minutes
        // Prevents ghost-online state after app kill + hours/days later restart
        const MAX_RESTORE_WINDOW_MS = 15 * 60 * 1000;
        const lastUpdate = driver.updatedAt ? new Date(driver.updatedAt).getTime() : 0;
        const timeSinceUpdate = Date.now() - lastUpdate;

        if (timeSinceUpdate > MAX_RESTORE_WINDOW_MS) {
          logger.info('[PRESENCE] Stale session, skipping auto-restore', {
            driverId,
            minutesSinceUpdate: Math.round(timeSinceUpdate / 60000),
          });
          // Clear the stale flag
          await prismaClient.user.update({
            where: { id: driverId },
            data: { isAvailable: false },
          });
          return false;
        }

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
        const alreadyEmitted = await redisService.get(throttleKey).catch((): null => null);
        if (!alreadyEmitted) {
          await redisService.set(throttleKey, '1', 10).catch(() => { }); // 10s TTL
          socketService.emitToUser(driver.transporterId, 'driver_status_changed', {
            driverId,
            driverName: driver.name || '',
            isOnline: true,
            action: 'reconnected',
            timestamp: new Date().toISOString()
          });
          fleetCacheService.invalidateDriverCache(driver.transporterId, driverId).catch((e: unknown) => {
            logger.warn('[DRIVER PRESENCE] Fleet cache invalidation failed (non-critical)', { driverId, error: getErrorMessage(e) });
          });
        } else {
          logger.debug('[DRIVER PRESENCE] Status emit throttled (duplicate reconnect within 10s)', { driverId });
        }

        logger.info('[DRIVER PRESENCE] Presence restored on reconnect', { driverId });
        return true;
      }
      return false;
    } catch (error: unknown) {
      logger.warn('[DRIVER PRESENCE] Failed to restore presence', {
        driverId,
        error: getErrorMessage(error)
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
    } catch (error: unknown) {
      logger.warn('[DRIVER PRESENCE] isDriverOnline check failed', {
        driverId,
        error: getErrorMessage(error)
      });
      return false;
    }
  }

  /**
   * Batch check if multiple drivers are online.
   * Uses parallel Redis exists + single DB findMany instead of N sequential isDriverOnline calls.
   *
   * @returns Map<driverId, boolean>
   */
  async areDriversOnline(driverIds: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (driverIds.length === 0) return result;

    try {
      // Parallel: Redis presence checks + single batch DB query
      const [presenceResults, dbResults] = await Promise.all([
        // Redis: parallel existence checks (N concurrent, not sequential)
        Promise.all(driverIds.map(id => redisService.exists(PRESENCE_KEY(id)))),
        // DB: single batch query instead of N individual findUnique calls
        prismaClient.user.findMany({
          where: { id: { in: driverIds } },
          select: { id: true, isAvailable: true }
        })
      ]);

      const dbAvailability = new Map(dbResults.map(u => [u.id, u.isAvailable === true]));

      for (let i = 0; i < driverIds.length; i++) {
        const redisOnline = presenceResults[i];
        const dbAvailable = dbAvailability.get(driverIds[i]) ?? false;
        result.set(driverIds[i], redisOnline && dbAvailable);
      }
    } catch (error: unknown) {
      logger.warn(`[Driver] Batch online check failed, falling back to individual: ${getErrorMessage(error)}`);
      // Fallback: check individually (guaranteed correctness)
      for (const driverId of driverIds) {
        const online = await this.isDriverOnline(driverId);
        result.set(driverId, online);
      }
    }

    return result;
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
    } catch (error: unknown) {
      logger.warn('[DRIVER PRESENCE] Failed to get online drivers', {
        transporterId,
        error: getErrorMessage(error)
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
    } catch (error: unknown) {
      logger.warn('[DRIVER PRESENCE] getAvailability failed, falling back to false', {
        userId,
        error: getErrorMessage(error)
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
    } catch (error: unknown) {
      // If it's our rate limit error, rethrow. Otherwise graceful degrade.
      if (error instanceof AppError && error.statusCode === 429) {
        throw error;
      }
      logger.warn('[TOGGLE PROTECTION] Rate limit check failed, proceeding without protection', {
        userId,
        error: getErrorMessage(error)
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
    } catch (error: unknown) {
      // DB read failed — proceed with toggle (better to double-write than block)
      logger.warn('[TOGGLE PROTECTION] Idempotency check failed, proceeding', {
        userId,
        error: getErrorMessage(error)
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
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }
      // Redis lock failed — proceed without lock (graceful degradation)
      logger.warn('[TOGGLE PROTECTION] Lock acquisition failed, proceeding without lock', {
        userId,
        error: getErrorMessage(error)
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
      } catch (error: unknown) {
        // Non-critical — cooldown not set, but toggle succeeded
        logger.warn('[TOGGLE PROTECTION] Failed to set cooldown', {
          userId,
          error: getErrorMessage(error)
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
        } catch (error: unknown) {
          logger.warn('[TOGGLE PROTECTION] Failed to release lock (will auto-expire)', {
            userId,
            error: getErrorMessage(error)
          });
        }
      }
    }
  }
}

export const driverPresenceService = new DriverPresenceService();
