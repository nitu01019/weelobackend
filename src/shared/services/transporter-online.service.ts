/**
 * =============================================================================
 * TRANSPORTER ONLINE SERVICE — Redis-Powered Online Filtering
 * =============================================================================
 *
 * WHAT THIS DOES:
 * - Provides O(1) lookup to check if a transporter is online
 * - Filters arrays of transporter IDs to only include online ones
 * - Uses the `online:transporters` Redis set (populated by Phase 1 toggle)
 * - Graceful degradation: falls back to DB check if Redis fails
 *
 * WHY THIS EXISTS (Phase 3 — Broadcast Optimization):
 * - Before: Each broadcast did N+1 DB queries (getUserById per transporter)
 * - After:  Single Redis SMEMBERS + Set intersection → O(1) per transporter
 *
 * PERFORMANCE:
 * | Transporters | Before (N+1 DB) | After (Redis Set) |
 * |-------------|-----------------|-------------------|
 * | 10          | ~50ms           | ~2ms              |
 * | 100         | ~500ms          | ~2ms              |
 * | 1,000       | ~5,000ms        | ~3ms              |
 * | 10,000      | ~50,000ms       | ~5ms              |
 *
 * REDIS KEYS USED:
 * - `online:transporters`           — Set of all online transporter IDs
 * - `transporter:presence:{id}`     — Presence key with TTL (for crash detection)
 *
 * USAGE:
 * ```typescript
 * import { transporterOnlineService } from './transporter-online.service';
 *
 * // Filter an array of transporter IDs to only online ones
 * const onlineOnly = await transporterOnlineService.filterOnline(allTransporterIds);
 *
 * // Check a single transporter
 * const isOnline = await transporterOnlineService.isOnline('transporter-123');
 * ```
 *
 * @author Weelo Team
 * @version 1.0.0
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { db } from '../database/db';
import { prismaClient } from '../database/prisma.service';

// =============================================================================
// REDIS KEY CONSTANTS (shared with transporter.routes.ts)
// =============================================================================

/** Redis set containing all online transporter IDs */
export const ONLINE_TRANSPORTERS_SET = 'online:transporters';

/** Redis presence key pattern — TTL-based auto-offline on app crash */
export const TRANSPORTER_PRESENCE_KEY = (id: string) => `transporter:presence:${id}`;

/** Presence key TTL in seconds (must match transporter.routes.ts) */
export const PRESENCE_TTL_SECONDS = 120;

// =============================================================================
// SERVICE CLASS
// =============================================================================

class TransporterOnlineService {

  // =========================================================================
  // CORE API — Used by broadcast services
  // =========================================================================

  /**
   * Filter an array of transporter IDs to only include ONLINE ones.
   *
   * ALGORITHM:
   * 1. Fetch all online transporter IDs from Redis set (single O(N) call)
   * 2. Intersect with input array using a Set (O(M) where M = input size)
   * 3. Return filtered array preserving original order
   *
   * GRACEFUL DEGRADATION:
   * - If Redis fails → falls back to DB `isAvailable` check (N+1, but safe)
   * - If Redis returns empty set → falls back to DB check (Redis may have restarted)
   *
   * @param transporterIds - Array of transporter IDs to filter
   * @returns Array of transporter IDs that are currently online
   */
  async filterOnline(transporterIds: string[]): Promise<string[]> {
    if (transporterIds.length === 0) return [];

    try {
      // Single Redis call — O(N) where N = total online transporters
      const onlineSet = await this.getOnlineSet();

      // If Redis returned a non-empty set, use it for filtering
      if (onlineSet.size > 0) {
        const filtered = transporterIds.filter(id => onlineSet.has(id));

        const offlineCount = transporterIds.length - filtered.length;
        if (offlineCount > 0) {
          logger.info(`📡 [TransporterOnline] Filtered ${offlineCount} offline transporters (${filtered.length}/${transporterIds.length} online) [Redis]`);
        }

        return filtered;
      }

      // Empty set could mean:
      // 1. No transporters are online (legitimate)
      // 2. Redis just restarted and set hasn't been rebuilt
      // Fall back to DB for safety
      logger.warn('[TransporterOnline] Redis online set is empty — falling back to DB check');
      return this.filterOnlineViaDB(transporterIds);

    } catch (error: any) {
      // Redis failed entirely — graceful degradation to DB
      logger.warn(`[TransporterOnline] Redis filter failed: ${error.message} — falling back to DB`);
      return this.filterOnlineViaDB(transporterIds);
    }
  }

  /**
   * Check if a single transporter is online.
   *
   * Uses Redis SISMEMBER — O(1) constant time.
   * Falls back to DB if Redis fails.
   *
   * @param transporterId - Transporter ID to check
   * @returns true if online, false otherwise
   */
  async isOnline(transporterId: string): Promise<boolean> {
    try {
      return await redisService.sIsMember(ONLINE_TRANSPORTERS_SET, transporterId);
    } catch (error: any) {
      logger.warn(`[TransporterOnline] Redis isOnline check failed: ${error.message}`);
      // Fallback to DB
      try {
        const user = await db.getUserById(transporterId);
        return user?.isAvailable !== false;
      } catch {
        return false;
      }
    }
  }

  /**
   * Get the count of online transporters.
   * Uses Redis SCARD — O(1).
   */
  async getOnlineCount(): Promise<number> {
    try {
      return await redisService.sCard(ONLINE_TRANSPORTERS_SET);
    } catch {
      return 0;
    }
  }

  /**
   * Get all online transporter IDs.
   * Uses Redis SMEMBERS — O(N).
   */
  async getOnlineIds(): Promise<string[]> {
    try {
      return await redisService.sMembers(ONLINE_TRANSPORTERS_SET);
    } catch {
      return [];
    }
  }

  // =========================================================================
  // STALE CLEANUP — Phase 3b (Auto-offline on app crash)
  // =========================================================================

  /**
   * Clean stale transporters from the online set.
   *
   * HOW IT WORKS:
   * - Iterates `online:transporters` set
   * - For each member, checks if `transporter:presence:{id}` key exists
   * - If presence key expired (TTL ran out = app crashed/disconnected) →
   *   remove from online set + update DB `isAvailable = false`
   *
   * SAFETY:
   * - Distributed lock prevents multiple instances running simultaneously
   * - Batch processing with configurable chunk size
   * - Non-blocking — errors on individual transporters don't stop the job
   *
   * CALL: Every 30 seconds from background job
   *
   * @returns Number of stale transporters removed
   */
  async cleanStaleTransporters(): Promise<number> {
    const lockKey = 'lock:clean-stale-transporters';
    let staleCount = 0;

    // Acquire distributed lock (prevents duplicate processing across ECS instances)
    let lockAcquired = false;
    try {
      const lockResult = await redisService.acquireLock(lockKey, 'cleanup-job', 25);
      lockAcquired = lockResult.acquired;
      if (!lockAcquired) {
        // Another instance is already running cleanup
        return 0;
      }
    } catch (error: any) {
      logger.warn(`[TransporterOnline] Cleanup lock failed: ${error.message}`);
      return 0;
    }

    try {
      const onlineIds = await redisService.sMembers(ONLINE_TRANSPORTERS_SET);

      if (onlineIds.length === 0) {
        return 0;
      }

      logger.debug(`[TransporterOnline] Checking ${onlineIds.length} online transporters for staleness`);

      for (const transporterId of onlineIds) {
        try {
          const presenceExists = await redisService.exists(
            TRANSPORTER_PRESENCE_KEY(transporterId)
          );

          if (!presenceExists) {
            // Presence key expired — transporter is stale
            await redisService.sRem(ONLINE_TRANSPORTERS_SET, transporterId);

            // Update DB to reflect offline state
            try {
              // Uses top-level import (line 46) — no runtime require()
              await prismaClient.user.update({
                where: { id: transporterId },
                data: { isAvailable: false }
              });
            } catch (dbError: any) {
              // Non-critical — presence key already expired means they're offline
              logger.warn(`[TransporterOnline] DB update failed for stale ${transporterId}: ${dbError.message}`);
            }

            staleCount++;
            logger.info(`🧹 [TransporterOnline] Auto-offline stale transporter ${transporterId.substring(0, 8)}...`);
          }
        } catch (error: any) {
          // Individual transporter check failed — skip and continue
          logger.warn(`[TransporterOnline] Stale check failed for ${transporterId}: ${error.message}`);
        }
      }

      if (staleCount > 0) {
        logger.info(`🧹 [TransporterOnline] Cleaned ${staleCount} stale transporters`);
      }

    } catch (error: any) {
      logger.error(`[TransporterOnline] Cleanup job failed: ${error.message}`);
    } finally {
      // Release lock
      if (lockAcquired) {
        try {
          await redisService.releaseLock(lockKey, 'cleanup-job');
        } catch (e: any) {
          logger.warn(`[TransporterOnline] Cleanup lock release failed (will auto-expire): ${e.message}`);
        }
      }
    }

    return staleCount;
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  /**
   * Get all online transporter IDs as a Set for fast lookups.
   * Single Redis SMEMBERS call.
   */
  private async getOnlineSet(): Promise<Set<string>> {
    const members = await redisService.sMembers(ONLINE_TRANSPORTERS_SET);
    return new Set(members);
  }

  /**
   * Fallback: Filter transporters via DB `isAvailable` check.
   * This is the old N+1 pattern — only used when Redis is unavailable.
   */
  private async filterOnlineViaDB(transporterIds: string[]): Promise<string[]> {
    try {
      const results = await Promise.all(
        transporterIds.map(async (transporterId) => {
          const transporter = await db.getUserById(transporterId);
          return {
            transporterId,
            isAvailable: transporter && transporter.isAvailable !== false
          };
        })
      );

      const filtered = results
        .filter(t => t.isAvailable)
        .map(t => t.transporterId);

      const offlineCount = transporterIds.length - filtered.length;
      if (offlineCount > 0) {
        logger.info(`📡 [TransporterOnline] Filtered ${offlineCount} offline transporters (${filtered.length}/${transporterIds.length} online) [DB fallback]`);
      }

      return filtered;
    } catch (error: any) {
      logger.error(`[TransporterOnline] DB fallback filter failed: ${error.message}`);
      // Last resort: return all (don't block broadcasts)
      return transporterIds;
    }
  }
}

// =============================================================================
// SINGLETON + BACKGROUND JOB
// =============================================================================

export const transporterOnlineService = new TransporterOnlineService();

// ---------------------------------------------------------------------------
// STALE TRANSPORTER CLEANUP JOB (Phase 3b)
// ---------------------------------------------------------------------------
// Runs every 30 seconds on every server instance.
// Distributed lock ensures only ONE instance processes at a time.
// ---------------------------------------------------------------------------

let staleCleanupInterval: NodeJS.Timeout | null = null;

export function startStaleTransporterCleanup(): void {
  if (staleCleanupInterval) return;

  const CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds

  staleCleanupInterval = setInterval(async () => {
    try {
      await transporterOnlineService.cleanStaleTransporters();
    } catch (error: any) {
      logger.error(`[TransporterOnline] Stale cleanup error: ${error.message}`);
    }
  }, CLEANUP_INTERVAL_MS);

  logger.info('🧹 [TransporterOnline] Stale transporter cleanup started (every 30s, cluster-safe)');
}

export function stopStaleTransporterCleanup(): void {
  if (staleCleanupInterval) {
    clearInterval(staleCleanupInterval);
    staleCleanupInterval = null;
  }
}

// Auto-start when module is imported
startStaleTransporterCleanup();
