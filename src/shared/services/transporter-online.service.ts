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
import { h3GeoIndexService } from './h3-geo-index.service';
import { TRANSPORTER_PRESENCE_TTL_SECONDS } from '../config/presence.config';

// =============================================================================
// REDIS KEY CONSTANTS (shared with transporter.routes.ts)
// =============================================================================

/** Redis set containing all online transporter IDs */
export const ONLINE_TRANSPORTERS_SET = 'online:transporters';

/** Redis presence key pattern — TTL-based auto-offline on app crash */
export const TRANSPORTER_PRESENCE_KEY = (id: string) => `transporter:presence:${id}`;

/**
 * Presence key TTL in seconds — sourced from the canonical presence config
 * (F-B-05 SSOT). Transporter TTL is 5× heartbeat (vs 3× for drivers) as a
 * documented exception: transporter apps spend more time backgrounded so
 * cellular-suspension tolerance per Discord gateway docs applies.
 */
export const PRESENCE_TTL_SECONDS = TRANSPORTER_PRESENCE_TTL_SECONDS;

// =============================================================================
// SERVICE CLASS
// =============================================================================

class TransporterOnlineService {

  /** Grace period: skip stale cleanup while Redis reconnects to avoid mass-offlining */
  private reconnectGraceUntil: number = 0;

  /**
   * Set a reconnect grace period during which stale cleanup is skipped.
   * Call this when Redis reconnects so heartbeats have time to repopulate.
   * @param ms Grace period in milliseconds (default 60s)
   */
  setReconnectGracePeriod(ms: number = 60000): void {
    this.reconnectGraceUntil = Date.now() + ms;
    logger.info(`[TransporterOnline] Reconnect grace period set for ${ms}ms`);
  }

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
    if (Date.now() < this.reconnectGraceUntil) {
      logger.info('[TransporterOnline] Skipping stale cleanup during reconnect grace');
      return 0;
    }

    // Standardized: lock: prefix for all distributed locks (added by acquireLock automatically)
    const lockKey = 'clean-stale-transporters';
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
      // FIX #13: Use SSCAN instead of SMEMBERS to avoid blocking Redis on large sets.
      // SMEMBERS is O(N) and blocks Redis for the entire duration. At 10K+ transporters,
      // this causes 100-500ms blocking every 30s. SSCAN iterates incrementally.
      // Pattern: Sidekiq issue #3848. Already proven at getOnlineSet() (line 319).
      const onlineIds: string[] = [];
      let scanCursor = '0';
      do {
        const [nextCursor, batch] = await redisService.sScan(
          ONLINE_TRANSPORTERS_SET, scanCursor, 200
        );
        scanCursor = nextCursor;
        onlineIds.push(...batch);
      } while (scanCursor !== '0');

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

            // FIX #2: Also clean geo + H3 indexes for stale transporters.
            // Previously only removed from online SET, leaving stale entries in
            // GEORADIUS and H3 cell sets for up to 90s (until TTL expiry).
            try {
              // Retrieve vehicle keys before they expire
              const vehicleKeys = await redisService.sMembers(
                `transporter:vehicle:keys:${transporterId}`
              ).catch(() => [] as string[]);
              const singleKey = await redisService.get(
                `transporter:vehicle:${transporterId}`
              ).catch(() => null);
              const allKeys = new Set([...vehicleKeys, ...(singleKey ? [singleKey] : [])]);
              for (const vk of allKeys) {
                if (vk) {
                  await redisService.geoRemove(`geo:transporters:${vk}`, transporterId);
                }
              }
              // Clean H3 index (fire-and-forget)
              h3GeoIndexService.removeTransporter(transporterId).catch(() => {});
            } catch (geoCleanupErr: any) {
              // Non-critical: geo entries will self-expire via TTL
              logger.warn(`[TransporterOnline] Geo cleanup failed for stale ${transporterId}: ${geoCleanupErr.message}`);
            }

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
            logger.info(`[TransporterOnline] Auto-offline stale transporter ${transporterId.substring(0, 8)}...`);
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
    // Use SSCAN instead of SMEMBERS to avoid blocking Redis on large sets (10K+ transporters)
    const members: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redisService.sScan(ONLINE_TRANSPORTERS_SET, cursor, 100);
      members.push(...batch);
      cursor = nextCursor;
    } while (cursor !== '0');
    return new Set(members);
  }

  /**
   * Fallback: Filter transporters via DB `isAvailable` check.
   * OPTIMIZED: Single findMany query instead of N+1 getUserById calls.
   * Only used when Redis is unavailable.
   */
  private async filterOnlineViaDB(transporterIds: string[]): Promise<string[]> {
    try {
      // PERF: Single query with IN clause — uses primary key index
      const onlineUsers = await prismaClient.user.findMany({
        where: {
          id: { in: transporterIds },
          isAvailable: true
        },
        select: { id: true }
      });

      const dbCandidates = onlineUsers.map(u => u.id);

      // Fix #23: Recency check via presence key.
      // At 3am or after Redis restart, DB isAvailable=true may be stale (transporters
      // who went offline without updating DB). Check transporter:presence:{id} key
      // existence as a recency signal. Only return transporters with active presence.
      // If Redis is unreachable, skip recency check (we're already in fallback).
      let filtered: string[];
      try {
        const presenceChecks = await Promise.all(
          dbCandidates.map(async (id) => {
            const hasPresence = await redisService.exists(
              TRANSPORTER_PRESENCE_KEY(id)
            );
            return { id, hasPresence };
          })
        );
        filtered = presenceChecks.filter(c => c.hasPresence).map(c => c.id);

        if (filtered.length === 0 && dbCandidates.length > 0) {
          logger.warn('[TransporterOnline] DB fallback found 0 transporters with recent presence. ' +
            'This may indicate Redis data loss or low-activity period (e.g. 3am).', {
            inputCount: transporterIds.length,
            dbCandidateCount: dbCandidates.length
          });
        }
      } catch {
        // Redis presence check failed -- fall through to DB-only result
        filtered = transporterIds.filter(id =>
          new Set(dbCandidates).has(id)
        );
      }

      // Preserve original input order
      const resultSet = new Set(filtered);
      const result = transporterIds.filter(id => resultSet.has(id));

      const offlineCount = transporterIds.length - result.length;
      if (offlineCount > 0) {
        logger.info(`📡 [TransporterOnline] Filtered ${offlineCount} offline transporters (${result.length}/${transporterIds.length} online) [DB fallback - batched + presence check]`);
      }

      return result;
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
  // L1 FIX: unref() so this non-critical timer doesn't block process exit
  staleCleanupInterval.unref();

  logger.info('[TransporterOnline] Stale transporter cleanup started (every 30s, cluster-safe)');
}

export function stopStaleTransporterCleanup(): void {
  if (staleCleanupInterval) {
    clearInterval(staleCleanupInterval);
    staleCleanupInterval = null;
  }
}

// M12 FIX: Removed auto-start side effect — caller must invoke startStaleTransporterCleanup()
// explicitly (e.g., from server.ts bootstrap). This prevents timers from firing on import
// during tests or when the module is imported for type-only purposes.
