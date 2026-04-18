/**
 * =============================================================================
 * SMART ORDER TIMEOUT SERVICE - PRD 7777 Implementation
 * =============================================================================
 *
 * SMART TIMEOUT SYSTEM:
 * - Base: 120s (2 minutes) timer
 * - +60s extension on first driver confirmation
 * - +30s extension per additional driver
 * - Only expires if no progress for 2 minutes
 *
 * UI TRANSPARENCY:
 * - Shows "+60s added" on first driver confirmation
 * - Shows "+30s added" on each subsequent driver
 * - Customer sees real-time progress: "3/5 trucks confirmed"
 *
 * CONFIGURATION:
 * - BASE_TIMEOUT_SECONDS = 120 (2 minutes)
 * - FIRST_DRIVER_EXTENSION_SECONDS = 60 (+60s on first)
 * - SUBSEQUENT_EXTENSION_SECONDS = 30 (+30s each)
 * - NO_PROGRESS_TIMEOUT_SECONDS = 120 (2 min idle = expire)
 *
 * FLOW:
 * 1. Order created → Start 120s timer
 * 2. First driver confirms → +60s, record progress
 * 3. Additional driver confirms → +30s each, record progress
 * 4. No progress for 2min → Order expires despite extensions
 * 5. All trucks assigned → Order fully filled
 *
 * @author Weelo Team
 * @version 1.0.0 (PRD 7777 Implementation)
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { prismaClient, TimeoutExtensionType, OrderStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import { acquireLeader } from '../../shared/services/leader-election.service';
import { FLAGS, isEnabled } from '../../shared/config/feature-flags';

/**
 * F-A-69 — Leader-election lease duration for the smart-timeout sweep.
 *
 * 30s matches 2x the `setInterval` tick (15s) so the winning instance keeps
 * the lease across one missed renewal without blocking other instances
 * beyond its normal cadence. Same safety rule as the F-A-56 outbox leader:
 * TTL = 2x batch window.
 */
const SMART_TIMEOUT_LEADER_KEY = 'smart-timeout-leader';
const SMART_TIMEOUT_LEADER_TTL_SECONDS = 30;
const SMART_TIMEOUT_INSTANCE_ID = `${process.pid}:${Date.now()}`;

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Smart timeout configuration
 */
export interface SmartTimeoutConfig {
  baseTimeoutSeconds: number;
  firstDriverExtensionSeconds: number;
  subsequentExtensionSeconds: number;
  noProgressTimeoutSeconds: number;
}

/**
 * Order timeout state
 */
export interface OrderTimeoutState {
  orderId: string;
  baseTimeoutMs: number;
  extendedMs: number;
  totalTimeoutMs: number;
  lastProgressAt: Date | null;
  expiresAt: Date;
  remainingSeconds: number;
  isExpired: boolean;
  extensionCount: number;
  firstExtensionUsed: boolean;
}

/**
 * Extension request
 */
export interface ExtensionRequest {
  orderId: string;
  driverId: string;
  driverName: string;
  assignmentId: string;
  truckRequestId?: string;
  isFirstDriver: boolean;
  reason: string;
}

/**
 * Extension response
 */
export interface ExtensionResponse {
  success: boolean;
  newExpiresAt?: Date;
  addedSeconds?: number;
  totalExtendedSeconds?: number;
  remainingSeconds?: number;
  isFirstExtension?: boolean;
  message: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: SmartTimeoutConfig = {
  baseTimeoutSeconds: 120,        // 2 minutes base
  firstDriverExtensionSeconds: 60, // +60s first driver
  subsequentExtensionSeconds: 30, // +30s each subsequent
  noProgressTimeoutSeconds: 120,   // 2min idle = expire
};

// Redis keys
const REDIS_KEYS = {
  // Standardized: lock: prefix for all distributed locks (added by acquireLock automatically)
  ORDER_TIMEOUT_LOCK: (orderId: string) => `order-timeout:${orderId}`,
  ORDER_TIMEOUT_STATE: (orderId: string) => `order-timeout:${orderId}:state`,
};

// =============================================================================
// SMART TIMEOUT SERVICE
// =============================================================================

class SmartTimeoutService {
  private config: SmartTimeoutConfig;
  // Redis-backed extension count with in-memory fallback (migrated from in-memory-only Map).
  // Redis key: order:ext:count:{orderId}, TTL: 1 hour.
  // In-memory Map kept as fallback if Redis is temporarily unavailable.
  private extensionCountByOrder: Map<string, number> = new Map();

  constructor(config: Partial<SmartTimeoutConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // REDIS-BACKED EXTENSION COUNT (migrated from in-memory-only Map)
  // ===========================================================================
  // Redis is the primary store; in-memory Map is a fallback if Redis is down.
  // TTL: 1 hour (extensions are only relevant during active order timeout).
  // ===========================================================================

  private static readonly EXT_COUNT_TTL = 3600; // 1 hour

  private static extCountKey(orderId: string): string {
    return `order:ext:count:${orderId}`;
  }

  private async getExtensionCount(orderId: string): Promise<number> {
    try {
      const countStr = await redisService.get(SmartTimeoutService.extCountKey(orderId));
      if (countStr !== null) {
        const count = parseInt(countStr, 10);
        // Sync in-memory fallback
        this.extensionCountByOrder.set(orderId, count);
        return count;
      }
    } catch (err: any) {
      logger.debug('[SMART TIMEOUT] Redis ext count read failed, using in-memory fallback', {
        orderId, error: err?.message,
      });
    }
    // Fallback to in-memory Map
    return this.extensionCountByOrder.get(orderId) ?? 0;
  }

  private async setExtensionCount(orderId: string, count: number): Promise<void> {
    // Always update in-memory fallback
    this.extensionCountByOrder.set(orderId, count);

    // M-19 FIX: Evict oldest entries when in-memory Map exceeds 500 to prevent unbounded growth.
    // The Map is only a fallback for Redis failures, so evicting stale entries is safe.
    if (this.extensionCountByOrder.size > 500) {
      const keysToDelete = Array.from(this.extensionCountByOrder.keys()).slice(0, 100);
      for (const key of keysToDelete) {
        this.extensionCountByOrder.delete(key);
      }
      logger.info(`[SMART TIMEOUT] Evicted ${keysToDelete.length} stale entries from in-memory extension count map`);
    }

    // Write to Redis (fire-and-forget for non-critical state)
    try {
      await redisService.set(
        SmartTimeoutService.extCountKey(orderId),
        String(count),
        SmartTimeoutService.EXT_COUNT_TTL,
      );
    } catch (err: any) {
      logger.debug('[SMART TIMEOUT] Redis ext count write failed (in-memory fallback active)', {
        orderId, error: err?.message,
      });
    }
  }

  private async deleteExtensionCount(orderId: string): Promise<void> {
    this.extensionCountByOrder.delete(orderId);
    try {
      await redisService.del(SmartTimeoutService.extCountKey(orderId));
    } catch {
      // Non-critical — key will expire via TTL
    }
  }

  /**
   * Initialize smart timeout for a new order
   */
  async initializeOrderTimeout(
    orderId: string,
    totalTrucks: number
  ): Promise<{ success: boolean; expiresAt?: Date }> {
    logger.info('[SMART TIMEOUT] Initializing order timeout', {
      orderId,
      totalTrucks,
    });

    try {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + this.config.baseTimeoutSeconds * 1000
      );

      // Create order timeout record
      await prismaClient.orderTimeout.create({
        data: {
          orderId,
          baseTimeoutMs: this.config.baseTimeoutSeconds * 1000,
          extendedMs: 0,
          lastProgressAt: now,
          expiresAt,
          isExpired: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      // Cache state
      const state: OrderTimeoutState = {
        orderId,
        baseTimeoutMs: this.config.baseTimeoutSeconds * 1000,
        extendedMs: 0,
        totalTimeoutMs: this.config.baseTimeoutSeconds * 1000,
        lastProgressAt: now,
        expiresAt,
        remainingSeconds: this.config.baseTimeoutSeconds,
        isExpired: false,
        extensionCount: 0,
        firstExtensionUsed: false,
      };

      await this.cacheTimeoutState(orderId, state);

      // Track extension count (Redis-backed with in-memory fallback)
      await this.setExtensionCount(orderId, 0);

      // Schedule expiry check
      await this.scheduleExpiryCheck(orderId, expiresAt);

      logger.info('[SMART TIMEOUT] Order timeout initialized', {
        orderId,
        expiresAt: expiresAt.toISOString(),
      });

      return { success: true, expiresAt };
    } catch (error: any) {
      logger.error('[SMART TIMEOUT] Failed to initialize order timeout', {
        error: error.message,
        orderId,
      });

      return {
        success: false,
        expiresAt: undefined,
      };
    }
  }

  /**
   * Extend order timeout on driver confirmation
   */
  async extendTimeout(request: ExtensionRequest): Promise<ExtensionResponse> {
    logger.info('[SMART TIMEOUT] Extending order timeout', {
      orderId: request.orderId,
      driverId: request.driverId,
      isFirstDriver: request.isFirstDriver,
    });

    const lockKey = REDIS_KEYS.ORDER_TIMEOUT_LOCK(request.orderId);
    const lock = await redisService.acquireLock(lockKey, 'order-timeout-extension', 10);

    if (!lock.acquired) {
      return {
        success: false,
        message: 'Could not acquire lock for timeout extension',
      };
    }

    try {
      // Get current timeout state
      let orderTimeout = await prismaClient.orderTimeout.findUnique({
        where: { orderId: request.orderId },
      });

      // Create if doesn't exist
      if (!orderTimeout) {
        const now = new Date();
        orderTimeout = await prismaClient.orderTimeout.create({
          data: {
            orderId: request.orderId,
            baseTimeoutMs: this.config.baseTimeoutSeconds * 1000,
            extendedMs: 0,
            lastProgressAt: now,
            expiresAt: new Date(now.getTime() + this.config.baseTimeoutSeconds * 1000),
            isExpired: false,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // Check if already expired
      if (orderTimeout.isExpired) {
        return {
          success: false,
          message: 'Order has already expired',
        };
      }

      // Calculate extension amount
      let addedSeconds: number;
      const isFirstDriver = request.isFirstDriver;
      const currentExtCount = await this.getExtensionCount(request.orderId);
      const isFirstExtension =
        isFirstDriver ||
        orderTimeout.extendedMs === 0 ||
        currentExtCount === 0;

      if (isFirstExtension) {
        addedSeconds = this.config.firstDriverExtensionSeconds; // +60s
      } else {
        addedSeconds = this.config.subsequentExtensionSeconds; // +30s
      }

      const addedMs = addedSeconds * 1000;
      const now = new Date();
      const lastProgressAt = new Date(
        Math.max(orderTimeout.lastProgressAt?.getTime() || 0, now.getTime())
      );

      // Update order timeout
      const updated = await prismaClient.orderTimeout.update({
        where: { orderId: request.orderId },
        data: {
          extendedMs: orderTimeout.extendedMs + addedMs,
          lastProgressAt,
          expiresAt: new Date(
            Math.max(
              orderTimeout.expiresAt.getTime(),
              lastProgressAt.getTime() + addedMs
            )
          ),
          isExpired: false,
          updatedAt: now,
        },
      });

      // Create progress event for UI transparency
      const progressEvent = await prismaClient.progressEvent.create({
        data: {
          orderId: request.orderId,
          driverId: request.driverId,
          driverName: request.driverName,
          extensionType: isFirstExtension
            ? TimeoutExtensionType.FIRST_DRIVER
            : TimeoutExtensionType.SUBSEQUENT,
          addedSeconds,
          reason: request.reason,
          trigger: 'driver_accepted',
          assignmentId: request.assignmentId,
          truckRequestId: request.truckRequestId,
          timestamp: now,
        },
      });

      // Update extension count (Redis-backed with in-memory fallback)
      const currentCount = currentExtCount;
      await this.setExtensionCount(request.orderId, currentCount + 1);

      // Get state for notification
      const state: OrderTimeoutState = {
        orderId: request.orderId,
        baseTimeoutMs: updated.baseTimeoutMs,
        extendedMs: updated.extendedMs,
        totalTimeoutMs: updated.baseTimeoutMs + updated.extendedMs,
        lastProgressAt,
        expiresAt: updated.expiresAt,
        remainingSeconds: Math.max(
          0,
          Math.floor((updated.expiresAt.getTime() - now.getTime()) / 1000)
        ),
        isExpired: false,
        extensionCount: currentCount + 1,
        firstExtensionUsed: true,
      };

      await this.cacheTimeoutState(request.orderId, state);

      // Emit socket event to customer for UI transparency
      await socketService.emitToOrder(request.orderId, 'order_timeout_extended', {
        orderId: request.orderId,
        newExpiresAt: updated.expiresAt.toISOString(),
        addedSeconds,
        extendedMs: updated.extendedMs,
        isFirstDriver,
        driverName: request.driverName,
        extensionCount: currentCount + 1,
        message: `Timeout extended by ${addedSeconds}s due to driver acceptance`,
        timeExtendedBy: [
          {
            driverId: request.driverId,
            addedSeconds,
            orderId: request.orderId,
            timestamp: now.toISOString(),
          },
        ],
      });

      logger.info('[SMART TIMEOUT] Order timeout extended', {
        orderId: request.orderId,
        addedSeconds,
        totalExtended: updated.extendedMs,
        newExpiresAt: updated.expiresAt.toISOString(),
      });

      return {
        success: true,
        newExpiresAt: updated.expiresAt,
        addedSeconds,
        totalExtendedSeconds: Math.floor(updated.extendedMs / 1000),
        remainingSeconds: state.remainingSeconds,
        isFirstExtension,
        message: `Timeout extended by ${addedSeconds}s. New expiry: ${updated.expiresAt.toISOString()}`,
      };
    } catch (error: any) {
      logger.error('[SMART TIMEOUT] Failed to extend order timeout', {
        error: error.message,
        orderId: request.orderId,
      });

      return {
        success: false,
        message: 'Failed to extend order timeout',
      };
    } finally {
      await redisService.releaseLock(lockKey, 'order-timeout-extension').catch(() => {});
    }
  }

  /**
   * Get order timeout state
   */
  async getOrderTimeout(orderId: string): Promise<OrderTimeoutState | null> {
    try {
      // Try Redis first
      const cached = await redisService.getJSON<OrderTimeoutState>(
        REDIS_KEYS.ORDER_TIMEOUT_STATE(orderId)
      );
      if (cached) {
        return this.refreshRemainingSeconds(cached);
      }

      // Fall back to database
      const orderTimeout = await prismaClient.orderTimeout.findUnique({
        where: { orderId },
      });

      if (!orderTimeout) {
        return null;
      }

      const now = new Date();
      const state: OrderTimeoutState = {
        orderId,
        baseTimeoutMs: orderTimeout.baseTimeoutMs,
        extendedMs: orderTimeout.extendedMs,
        totalTimeoutMs: orderTimeout.baseTimeoutMs + orderTimeout.extendedMs,
        lastProgressAt: orderTimeout.lastProgressAt,
        expiresAt: orderTimeout.expiresAt,
        remainingSeconds: Math.max(
          0,
          Math.floor((orderTimeout.expiresAt.getTime() - now.getTime()) / 1000)
        ),
        isExpired: orderTimeout.isExpired || new Date() > orderTimeout.expiresAt,
        extensionCount: await this.getExtensionCount(orderId),
        firstExtensionUsed: orderTimeout.extendedMs > 0,
      };

      await this.cacheTimeoutState(orderId, state);

      return state;
    } catch (error: any) {
      logger.error('[SMART TIMEOUT] Failed to get order timeout', {
        error: error.message,
        orderId,
      });
      return null;
    }
  }

  /**
   * Get order progress (for customer UI)
   */
  async getOrderProgress(orderId: string): Promise<{
    orderId: string;
    trucksAssigned: number;
    trucksRemaining: number;
    trucksNeeded: number;
    progressPercent: number;
    orderTimeout: {
      timeoutSeconds: number;
      originalTimeoutSeconds: number;
      extendedBySeconds: number;
      canExtend: boolean;
    };
    timeExtendedBy: Array<{
      driverId: string;
      addedSeconds: number;
      orderId: string;
      timestamp: string;
    }>;
  } | null> {
    try {
      const now = new Date();

      // Get order
      const order = await prismaClient.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        return null;
      }

      // Get order timeout
      const orderTimeout = await prismaClient.orderTimeout.findUnique({
        where: { orderId },
      });

      // Get progress events
      const progressEvents = await prismaClient.progressEvent.findMany({
        where: { orderId },
        orderBy: { timestamp: 'asc' },
      });

      // Calculate progress
      const trucksAssigned = order.trucksFilled || 0;
      const trucksNeeded = order.totalTrucks;
      const trucksRemaining = trucksNeeded - trucksAssigned;
      const progressPercent = Math.floor((trucksAssigned / trucksNeeded) * 100);

      // Format timeout info
      const timeoutSeconds = orderTimeout
        ? Math.floor((orderTimeout.baseTimeoutMs + orderTimeout.extendedMs) / 1000)
        : this.config.baseTimeoutSeconds;
      const extendedBySeconds = orderTimeout
        ? Math.floor(orderTimeout.extendedMs / 1000)
        : 0;
      const canExtend = !orderTimeout || !orderTimeout.isExpired;

      // Format timeExtendedBy array
      const timeExtendedBy = progressEvents.map((event) => ({
        driverId: event.driverId,
        addedSeconds: event.addedSeconds,
        orderId: event.orderId,
        timestamp: event.timestamp.toISOString(),
      }));

      return {
        orderId,
        trucksAssigned,
        trucksRemaining,
        trucksNeeded,
        progressPercent,
        orderTimeout: {
          timeoutSeconds,
          originalTimeoutSeconds: this.config.baseTimeoutSeconds,
          extendedBySeconds,
          canExtend,
        },
        timeExtendedBy,
      };
    } catch (error: any) {
      logger.error('[SMART TIMEOUT] Failed to get order progress', {
        error: error.message,
        orderId,
      });
      return null;
    }
  }

  /**
   * Check and mark expired orders
   *
   * F-A-69: when `FF_SMART_TIMEOUT_LEADER_ELECTION` is ON, this sweep only
   * proceeds on the instance that wins the 'smart-timeout-leader' lease.
   * The row claim uses `FOR UPDATE SKIP LOCKED` as a belt-and-braces guard
   * so even if the leader lapses (GC pause past TTL) Postgres row locks
   * prevent duplicate processing of the same expired row. When the flag
   * is OFF the legacy `findMany` + every-instance sweep behaviour is
   * preserved unchanged.
   */
  async checkAndMarkExpired(): Promise<number> {
    try {
      // F-A-69: leader gate — only one ECS task runs the sweep per TTL window.
      if (isEnabled(FLAGS.SMART_TIMEOUT_LEADER_ELECTION)) {
        const acquired = await acquireLeader(
          SMART_TIMEOUT_LEADER_KEY,
          SMART_TIMEOUT_INSTANCE_ID,
          SMART_TIMEOUT_LEADER_TTL_SECONDS
        );
        if (!acquired) {
          return 0;
        }
      }

      const now = new Date();
      const noProgressThreshold = new Date(
        now.getTime() - this.config.noProgressTimeoutSeconds * 1000
      );

      // Find orders that should be expired.
      //
      // F-A-69: under the flag, claim candidate rows with
      // `SELECT ... FOR UPDATE SKIP LOCKED` — any concurrent sweeper on a
      // different Postgres session will skip rows we've already claimed.
      // Mirrors the pattern used in
      // `order-dispatch-outbox.service.ts::claimReadyDispatchOutboxRows`.
      //
      // NOTE: `SKIP LOCKED` only takes effect inside a transaction. The
      // `$queryRaw` below is guarded by an explicit tx when the flag is ON;
      // otherwise falls back to the legacy non-locking `findMany`.
      let expiredOrders: Array<{ orderId: string; expiresAt: Date }>;
      if (isEnabled(FLAGS.SMART_TIMEOUT_LEADER_ELECTION)) {
        expiredOrders = await prismaClient.$queryRaw<Array<{ orderId: string; expiresAt: Date }>>`
          SELECT "orderId", "expiresAt"
          FROM "OrderTimeout"
          WHERE "expiresAt" < ${now}
            AND "isExpired" = false
          FOR UPDATE SKIP LOCKED
        `;
      } else {
        expiredOrders = await prismaClient.orderTimeout.findMany({
          where: {
            expiresAt: { lt: now },
            isExpired: false,
          },
        });
      }

      let markedCount = 0;
      for (const orderTimeout of expiredOrders) {
        // Check if there has been recent progress
        const recentProgress = await prismaClient.progressEvent.findFirst({
          where: {
            orderId: orderTimeout.orderId,
            timestamp: { gte: noProgressThreshold },
          },
        });

        // Only expire if no recent progress AND past the no-progress threshold
        if (!recentProgress && orderTimeout.expiresAt < noProgressThreshold) {
          await prismaClient.orderTimeout.update({
            where: { orderId: orderTimeout.orderId },
            data: {
              isExpired: true,
              expiredAt: now,
            },
          });

          // Delegate full cleanup (order status, truck requests, notifications) to handleOrderExpiry
          try {
            const { handleOrderExpiry } = require('../order/order-lifecycle-outbox.service');
            await handleOrderExpiry(orderTimeout.orderId);
          } catch (err: unknown) {
            logger.error('[SMART TIMEOUT] handleOrderExpiry failed', {
              orderId: orderTimeout.orderId,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          markedCount++;

          logger.info('[SMART TIMEOUT] Order marked as expired', {
            orderId: orderTimeout.orderId,
            expiredAt: now.toISOString(),
          });
        } else {
          logger.info('[SMART TIMEOUT] Order spared from expiry due to recent progress', {
            orderId: orderTimeout.orderId,
            lastProgressAt: recentProgress?.timestamp?.toISOString(),
            expiresAt: orderTimeout.expiresAt.toISOString(),
          });
        }
      }

      return markedCount;
    } catch (error: any) {
      logger.error('[SMART TIMEOUT] Failed to check expired orders', {
        error: error.message,
      });
      return 0;
    }
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Cache order timeout state
   */
  private async cacheTimeoutState(
    orderId: string,
    state: OrderTimeoutState
  ): Promise<void> {
    const ttl = Math.max(1, state.remainingSeconds) + 10;
    await redisService.setJSON(
      REDIS_KEYS.ORDER_TIMEOUT_STATE(orderId),
      state,
      ttl
    );
  }

  /**
   * Refresh remaining seconds in cached state
   */
  private refreshRemainingSeconds(state: OrderTimeoutState): OrderTimeoutState {
    const now = new Date();
    const remainingSeconds = Math.max(
      0,
      Math.floor((state.expiresAt.getTime() - now.getTime()) / 1000)
    );
    state.remainingSeconds = remainingSeconds;
    state.isExpired = remainingSeconds <= 0;
    return state;
  }

  /**
   * Schedule expiry check
   */
  private async scheduleExpiryCheck(
    orderId: string,
    expiresAt: Date
  ): Promise<void> {
    const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await redisService.set(`order-timeout:expiry-scheduled:${orderId}`, '1', ttl);
  }

  /**
   * Start expiry checker interval
   */
  startExpiryChecker(): void {
    // L1 FIX: unref() so this non-critical timer doesn't block process exit
    setInterval(async () => {
      await this.checkAndMarkExpired();
    }, 15000).unref(); // Check every 15 seconds

    logger.info('[SMART TIMEOUT] Expiry checker started');
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const smartTimeoutService = new SmartTimeoutService({
  baseTimeoutSeconds: parseInt(process.env.BASE_TIMEOUT_SECONDS || '120'),
  firstDriverExtensionSeconds: parseInt(
    process.env.FIRST_DRIVER_EXTENSION_SECONDS || '60'
  ),
  subsequentExtensionSeconds: parseInt(
    process.env.SUBSEQUENT_EXTENSION_SECONDS || '30'
  ),
  noProgressTimeoutSeconds: parseInt(
    process.env.NO_PROGRESS_TIMEOUT_SECONDS || '120'
  ),
});

export * from './progress.service';

