/**
 * =============================================================================
 * LIVE AVAILABILITY SERVICE — Real-Time Redis Set + Hash for Vehicle Availability
 * =============================================================================
 *
 * WHAT THIS DOES:
 * Maintains a live, always-up-to-date Redis index of which transporters have
 * available vehicles of each type, and how many. Zero cache TTL. Zero DB queries
 * during broadcasts.
 *
 * DATA STRUCTURES:
 * - Redis Set  `avail_set:{vehicleKey}`   → members are transporterIds with ≥1 available truck
 * - Redis Hash `avail_count:{vehicleKey}` → field per transporterId, value = available count
 *
 * ATOMICITY:
 * Uses a Lua script to atomically HINCRBY + SADD/SREM in one Redis call.
 * This prevents any race condition between count and set membership.
 *
 * SAFETY:
 * - If Redis is down, callers fall through to DB queries (no breakage)
 * - Periodic reconciliation (every 5min) corrects any drift
 * - Bootstrap on startup repopulates from DB
 *
 * @version 1.0.0
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';

// Lazy import of main PrismaClient singleton — avoids circular deps with prisma.service.ts
// Reuses the managed connection pool (connection_limit=20, pool_timeout=5)
// instead of creating a separate uncontrolled pool.
let _prisma: any = null;
function getLazyPrisma() {
  if (!_prisma) {
    const { prismaClient } = require('../database/prisma.service');
    _prisma = prismaClient;
  }
  return _prisma;
}

// =============================================================================
// LUA SCRIPT — Atomic count update + set membership management
// =============================================================================
// KEYS[1] = avail_count:{vehicleKey}  (Hash)
// KEYS[2] = avail_set:{vehicleKey}    (Set)
// ARGV[1] = transporterId
// ARGV[2] = increment (+1 or -1)
//
// Returns the new count (or 0 if cleaned up)
// =============================================================================
const LUA_UPDATE_AVAILABILITY = `
local newCount = redis.call('HINCRBY', KEYS[1], ARGV[1], tonumber(ARGV[2]))
if newCount <= 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 0
else
  redis.call('SADD', KEYS[2], ARGV[1])
  return newCount
end
`;

// =============================================================================
// KEY HELPERS
// =============================================================================

function countKey(vehicleKey: string): string {
  return `avail_count:${vehicleKey}`;
}

function setKey(vehicleKey: string): string {
  return `avail_set:${vehicleKey}`;
}

// =============================================================================
// SERVICE
// =============================================================================

class LiveAvailabilityService {

  /**
   * Atomically update availability count and set membership.
   * Uses Lua script so HINCRBY + SADD/SREM execute as one atomic op.
   *
   * @param transporterId - The transporter
   * @param vehicleKey    - e.g. "open_17ft"
   * @param increment     - +1 (became available) or -1 (left available)
   * @returns new count (0 means removed from set)
   */
  async updateAvailability(
    transporterId: string,
    vehicleKey: string,
    increment: number
  ): Promise<number> {
    if (!vehicleKey || !transporterId) return 0;

    try {
      const result = await redisService.eval(
        LUA_UPDATE_AVAILABILITY,
        [countKey(vehicleKey), setKey(vehicleKey)],
        [transporterId, String(increment)]
      );
      const newCount = typeof result === 'number' ? result : parseInt(String(result), 10) || 0;
      logger.debug(`[LiveAvail] ${transporterId} ${vehicleKey}: ${increment > 0 ? '+' : ''}${increment} → count=${newCount}`);
      return newCount;
    } catch (err: any) {
      logger.warn(`[LiveAvail] updateAvailability failed: ${err.message}`);
      return 0;
    }
  }

  /**
   * Called when a vehicle's status changes.
   * Only acts when crossing the 'available' boundary.
   */
  async onVehicleStatusChange(
    transporterId: string,
    vehicleKey: string,
    oldStatus: string,
    newStatus: string
  ): Promise<void> {
    if (!vehicleKey || !transporterId) return;
    if (oldStatus === newStatus) return;

    if (oldStatus === 'available' && newStatus !== 'available') {
      // Truck left available → decrement
      await this.updateAvailability(transporterId, vehicleKey, -1);
    } else if (oldStatus !== 'available' && newStatus === 'available') {
      // Truck became available → increment
      await this.updateAvailability(transporterId, vehicleKey, +1);
    }
  }

  /**
   * Called when a new vehicle is created with status='available'.
   */
  async onVehicleCreated(transporterId: string, vehicleKey: string): Promise<void> {
    if (!vehicleKey || !transporterId) return;
    await this.updateAvailability(transporterId, vehicleKey, +1);
    logger.info(`[LiveAvail] Vehicle created: ${transporterId} +1 ${vehicleKey}`);
  }

  /**
   * Called when a vehicle is deleted/deactivated while status was 'available'.
   */
  async onVehicleRemoved(transporterId: string, vehicleKey: string): Promise<void> {
    if (!vehicleKey || !transporterId) return;
    await this.updateAvailability(transporterId, vehicleKey, -1);
    logger.info(`[LiveAvail] Vehicle removed: ${transporterId} -1 ${vehicleKey}`);
  }

  /**
   * Get availability snapshot from Redis — replaces the 2 DB queries.
   * Returns the same format as getTransportersAvailabilitySnapshot.
   *
   * @param vehicleKey - e.g. "open_17ft"
   * @returns Array of { transporterId, transporterName, totalOwned, available, inTransit }
   */
  async getSnapshotFromRedis(
    vehicleKey: string
  ): Promise<Array<{
    transporterId: string;
    transporterName: string;
    totalOwned: number;
    available: number;
    inTransit: number;
  }> | null> {
    try {
      // Get all counts for this vehicle key
      const counts = await redisService.hGetAll(countKey(vehicleKey));
      if (!counts || Object.keys(counts).length === 0) return null;

      const transporterIds = Object.keys(counts);
      const result: Array<{
        transporterId: string;
        transporterName: string;
        totalOwned: number;
        available: number;
        inTransit: number;
      }> = [];

      // Batch fetch transporter names from Redis cache
      const nameKeys = transporterIds.map(id => `transporter:details:${id}`);
      let detailsBatch: Record<string, string>[] = [];
      try {
        detailsBatch = await redisService.hGetAllBatch(nameKeys);
      } catch { /* fall through with empty names */ }

      for (let i = 0; i < transporterIds.length; i++) {
        const tid = transporterIds[i];
        const available = parseInt(counts[tid], 10) || 0;
        if (available <= 0) continue;

        const details = detailsBatch[i] || {};
        const name = details.businessName || details.name || 'Unknown';

        result.push({
          transporterId: tid,
          transporterName: name,
          totalOwned: available, // We only track available count in Redis
          available,
          inTransit: 0 // Not tracked in Redis (not needed for filtering)
        });
      }

      return result.length > 0 ? result : null;
    } catch (err: any) {
      logger.warn(`[LiveAvail] getSnapshotFromRedis failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Bootstrap: rebuild Redis sets from database.
   * Called once on server startup.
   */
  async rebuildFromDatabase(): Promise<void> {
    try {
      const prisma = getLazyPrisma();

      const vehicles = await prisma.vehicle.findMany({
        where: { isActive: true, status: 'available' },
        select: { transporterId: true, vehicleKey: true },
        take: 1000  // Safety limit — log warning if hit
      });
      if (vehicles.length >= 1000) {
        logger.warn('[LiveAvail] Bootstrap hit 1000 vehicle limit — consider pagination');
      }

      // Group by vehicleKey → transporterId → count
      const groups = new Map<string, Map<string, number>>();
      for (const v of vehicles) {
        if (!v.vehicleKey || !v.transporterId) continue;
        if (!groups.has(v.vehicleKey)) groups.set(v.vehicleKey, new Map());
        const tMap = groups.get(v.vehicleKey)!;
        tMap.set(v.transporterId, (tMap.get(v.transporterId) || 0) + 1);
      }

      let totalKeys = 0;
      let totalTransporters = 0;

      for (const [vKey, tMap] of groups) {
        totalKeys++;

        // CRITICAL: Delete old keys FIRST to clear stale data from previous runs
        await redisService.del(countKey(vKey));
        await redisService.del(setKey(vKey));

        const members: string[] = [];
        const countData: Record<string, string> = {};

        for (const [tid, count] of tMap) {
          members.push(tid);
          countData[tid] = String(count);
          totalTransporters++;
        }

        // Set count hash
        if (Object.keys(countData).length > 0) {
          await redisService.hMSet(countKey(vKey), countData);
        }
        // Set availability set
        if (members.length > 0) {
          await redisService.sAdd(setKey(vKey), ...members);
        }
      }

      logger.info(`[LiveAvail] ✅ Bootstrap complete: ${totalKeys} vehicle keys, ${totalTransporters} transporter entries`);
    } catch (err: any) {
      logger.error(`[LiveAvail] Bootstrap failed: ${err.message}`);
    }
  }

  /**
   * Periodic reconciliation: compare Redis with DB and fix any drift.
   * Called every 5 minutes as a safety net.
   */
  async reconcile(): Promise<void> {
    // Distributed lock — only one ECS instance reconciles at a time
    const lockKey = 'lock:liveavail-reconcile';
    let lockAcquired = false;
    try {
      const lockResult = await redisService.acquireLock(lockKey, 'reconcile', 120);
      lockAcquired = lockResult.acquired;
      if (!lockAcquired) return; // Another instance is handling this
    } catch (_) { /* Redis down — proceed without lock */ }

    try {
      const prisma = getLazyPrisma();

      const vehicles = await prisma.vehicle.findMany({
        where: { isActive: true },
        select: { transporterId: true, vehicleKey: true, status: true },
        take: 1000  // Safety limit
      });
      if (vehicles.length >= 1000) {
        logger.warn('[LiveAvail] Reconcile hit 1000 vehicle limit — consider pagination');
      }

      // Build ground truth: vehicleKey → transporterId → available count
      const groundTruth = new Map<string, Map<string, number>>();
      for (const v of vehicles) {
        if (!v.vehicleKey || !v.transporterId) continue;
        if (!groundTruth.has(v.vehicleKey)) groundTruth.set(v.vehicleKey, new Map());
        const tMap = groundTruth.get(v.vehicleKey)!;
        if (v.status === 'available') {
          tMap.set(v.transporterId, (tMap.get(v.transporterId) || 0) + 1);
        } else {
          // Ensure entry exists even if 0
          if (!tMap.has(v.transporterId)) tMap.set(v.transporterId, 0);
        }
      }

      let corrections = 0;

      // Compare with Redis
      for (const [vKey, tMap] of groundTruth) {
        const redisCounts = await redisService.hGetAll(countKey(vKey));

        for (const [tid, dbCount] of tMap) {
          const redisCount = parseInt(redisCounts[tid] || '0', 10);

          if (redisCount !== dbCount) {
            corrections++;
            logger.warn(`[LiveAvail] DRIFT: ${vKey}/${tid} Redis=${redisCount} DB=${dbCount} — correcting`);

            if (dbCount > 0) {
              await redisService.hSet(countKey(vKey), tid, String(dbCount));
              await redisService.sAdd(setKey(vKey), tid);
            } else {
              await redisService.hDel(countKey(vKey), tid);
              await redisService.sRem(setKey(vKey), tid);
            }
          }
        }

        // Check for Redis entries not in DB (stale entries)
        for (const redisTid of Object.keys(redisCounts)) {
          if (!tMap.has(redisTid)) {
            corrections++;
            logger.warn(`[LiveAvail] STALE: ${vKey}/${redisTid} in Redis but not in DB — removing`);
            await redisService.hDel(countKey(vKey), redisTid);
            await redisService.sRem(setKey(vKey), redisTid);
          }
        }
      }

      if (corrections > 0) {
        logger.info(`[LiveAvail] Reconciliation done: ${corrections} corrections applied`);
      } else {
        logger.debug(`[LiveAvail] Reconciliation done: 0 corrections (all in sync)`);
      }
    } catch (err: any) {
      logger.warn(`[LiveAvail] Reconciliation failed: ${err.message}`);
    } finally {
      if (lockAcquired) {
        redisService.releaseLock(lockKey, 'reconcile').catch(() => {});
      }
    }
  }
}

export const liveAvailabilityService = new LiveAvailabilityService();
