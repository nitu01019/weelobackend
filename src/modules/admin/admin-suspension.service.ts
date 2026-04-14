/**
 * =============================================================================
 * ADMIN SUSPENSION SERVICE
 * =============================================================================
 *
 * Manages user suspension state entirely in Redis (no DB migration needed).
 *
 * REDIS KEYS:
 *   suspension:{userId}          - JSON payload with suspension details (TTL = duration)
 *   suspension:history:{userId}  - Append-only list of admin actions (capped at 100)
 *
 * FEATURES:
 *   - Suspend user for N hours (auto-unsuspend via TTL expiry)
 *   - Warn user (audit record only, no suspension)
 *   - Unsuspend user manually
 *   - Query suspension status
 *   - Full action history (audit log)
 *
 * SCALABILITY:
 *   - Stateless: any server instance can read/write suspension state
 *   - TTL-based: Redis handles auto-expiry without cron jobs
 *   - Audit log capped at 100 entries per user (LTRIM)
 * =============================================================================
 */

import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';

// =============================================================================
// TYPES
// =============================================================================

export interface SuspensionStatus {
  readonly status: 'suspended';
  readonly reason: string;
  readonly suspendedBy: string;
  readonly suspendedAt: string;
  readonly expiresAt: string;
  readonly durationHours: number;
}

export interface AdminAction {
  readonly action: 'suspend' | 'warn' | 'unsuspend';
  readonly reason: string;
  readonly adminId: string;
  readonly timestamp: string;
  readonly durationHours?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SUSPENSION_KEY_PREFIX = 'suspension:';
const HISTORY_KEY_PREFIX = 'suspension:history:';
const MAX_HISTORY_ENTRIES = 100;
const MAX_SUSPENSION_HOURS = 8760; // 1 year
const MIN_SUSPENSION_HOURS = 0.0167; // ~1 minute

// =============================================================================
// SERVICE
// =============================================================================

class AdminSuspensionService {

  /**
   * Suspend a user for a given duration.
   * The suspension auto-expires when the Redis TTL runs out.
   */
  async suspendUser(
    userId: string,
    reason: string,
    durationHours: number,
    adminId: string
  ): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId is required');
    }
    if (!reason || typeof reason !== 'string') {
      throw new Error('reason is required');
    }
    if (
      typeof durationHours !== 'number' ||
      !Number.isFinite(durationHours) ||
      durationHours < MIN_SUSPENSION_HOURS ||
      durationHours > MAX_SUSPENSION_HOURS
    ) {
      throw new Error(
        `durationHours must be between ${MIN_SUSPENSION_HOURS} and ${MAX_SUSPENSION_HOURS}`
      );
    }
    if (!adminId || typeof adminId !== 'string') {
      throw new Error('adminId is required');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationHours * 3600 * 1000);
    const ttlSeconds = Math.ceil(durationHours * 3600);

    const payload: SuspensionStatus = {
      status: 'suspended',
      reason,
      suspendedBy: adminId,
      suspendedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      durationHours,
    };

    const key = `${SUSPENSION_KEY_PREFIX}${userId}`;
    await redisService.set(key, JSON.stringify(payload), ttlSeconds);

    await this.appendHistory(userId, {
      action: 'suspend',
      reason,
      adminId,
      timestamp: now.toISOString(),
      durationHours,
    });

    logger.info('[AdminSuspension] User suspended', {
      userId,
      adminId,
      reason,
      durationHours,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Issue a warning to a user (audit record only, no suspension).
   */
  async warnUser(
    userId: string,
    reason: string,
    adminId: string
  ): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId is required');
    }
    if (!reason || typeof reason !== 'string') {
      throw new Error('reason is required');
    }
    if (!adminId || typeof adminId !== 'string') {
      throw new Error('adminId is required');
    }

    const now = new Date();

    await this.appendHistory(userId, {
      action: 'warn',
      reason,
      adminId,
      timestamp: now.toISOString(),
    });

    logger.info('[AdminSuspension] User warned', {
      userId,
      adminId,
      reason,
    });
  }

  /**
   * Manually unsuspend a user (removes the Redis key immediately).
   */
  async unsuspendUser(
    userId: string,
    adminId: string,
    reason?: string
  ): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId is required');
    }
    if (!adminId || typeof adminId !== 'string') {
      throw new Error('adminId is required');
    }

    const key = `${SUSPENSION_KEY_PREFIX}${userId}`;
    await redisService.del(key);

    const now = new Date();

    await this.appendHistory(userId, {
      action: 'unsuspend',
      reason: reason || 'Manually unsuspended by admin',
      adminId,
      timestamp: now.toISOString(),
    });

    logger.info('[AdminSuspension] User unsuspended', {
      userId,
      adminId,
      reason: reason || 'manual',
    });
  }

  /**
   * Get the current suspension status for a user.
   * Returns null if the user is not suspended.
   */
  async getUserSuspensionStatus(userId: string): Promise<SuspensionStatus | null> {
    if (!userId) return null;

    const key = `${SUSPENSION_KEY_PREFIX}${userId}`;
    try {
      const raw = await redisService.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'status' in parsed &&
        (parsed as Record<string, unknown>).status === 'suspended'
      ) {
        return parsed as SuspensionStatus;
      }
      return null;
    } catch {
      logger.warn('[AdminSuspension] Failed to read suspension status', { userId });
      return null;
    }
  }

  /**
   * Fast boolean check: is the user currently suspended?
   * Used in hot paths (middleware, broadcast filtering).
   */
  async isUserSuspended(userId: string): Promise<boolean> {
    if (!userId) return false;
    const key = `${SUSPENSION_KEY_PREFIX}${userId}`;
    try {
      return await redisService.exists(key);
    } catch {
      // Redis failure = fail open (don't block the user)
      logger.warn('[AdminSuspension] Redis check failed, failing open', { userId });
      return false;
    }
  }

  /**
   * Batch suspension check: returns the set of userIds that are currently suspended.
   * Uses a single Redis PIPELINE of EXISTS calls instead of N individual round-trips.
   * Used in broadcast hot paths to eliminate N+1 Redis calls.
   */
  async getSuspendedUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const uniqueIds = Array.from(new Set(userIds));
    const keys = uniqueIds.map((id) => `${SUSPENSION_KEY_PREFIX}${id}`);

    try {
      // Use Lua script for atomic batch EXISTS in a single round-trip
      const script = `
        local results = {}
        for i, key in ipairs(KEYS) do
          results[i] = redis.call('EXISTS', key)
        end
        return results
      `;
      const results = await redisService.eval(script, keys, []);

      const suspendedSet = new Set<string>();
      if (Array.isArray(results)) {
        for (let i = 0; i < uniqueIds.length; i++) {
          if (results[i] === 1) {
            suspendedSet.add(uniqueIds[i]);
          }
        }
      }
      return suspendedSet;
    } catch (err) {
      // Fail open: if batch check fails, fall back to individual checks
      logger.warn('[AdminSuspension] Batch suspension check failed, falling back to individual checks', {
        userCount: uniqueIds.length,
        error: err instanceof Error ? err.message : String(err),
      });
      const suspendedSet = new Set<string>();
      for (const userId of uniqueIds) {
        const isSuspended = await this.isUserSuspended(userId);
        if (isSuspended) {
          suspendedSet.add(userId);
        }
      }
      return suspendedSet;
    }
  }

  /**
   * Get full action history for a user (most recent first).
   */
  async getActionHistory(userId: string): Promise<AdminAction[]> {
    if (!userId) return [];
    const key = `${HISTORY_KEY_PREFIX}${userId}`;
    try {
      const rawEntries = await redisService.lRange(key, 0, MAX_HISTORY_ENTRIES - 1);
      return rawEntries
        .map((raw) => {
          try {
            return JSON.parse(raw) as AdminAction;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is AdminAction => entry !== null);
    } catch {
      logger.warn('[AdminSuspension] Failed to read action history', { userId });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Append an action to the user's audit history (LPUSH + LTRIM).
   */
  private async appendHistory(userId: string, action: AdminAction): Promise<void> {
    const key = `${HISTORY_KEY_PREFIX}${userId}`;
    try {
      await redisService.lPush(key, JSON.stringify(action));
      await redisService.lTrim(key, 0, MAX_HISTORY_ENTRIES - 1);
    } catch (err) {
      logger.warn('[AdminSuspension] Failed to write action history', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Singleton export
export const adminSuspensionService = new AdminSuspensionService();
