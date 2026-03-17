/**
 * =============================================================================
 * TRUCK HOLD SERVICE - Race Condition Prevention for Million-User Scale
 * =============================================================================
 * 
 * Handles the "BookMyShow-style" truck holding system for broadcast orders.
 * 
 * ⭐ GOLDEN RULE (NEVER FORGET):
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   DATABASE ATOMIC CLAIM IS THE FINAL TRUTH. REDIS IS OPTIONAL ACCELERATION.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Atomic DB claim is the boundary that prevents double-assignment.
 * 
 * THE PROBLEM THIS SOLVES:
 * ────────────────────────
 * Imagine 10 transporters see the same order and tap "Accept" at almost the
 * same time. Without Redis locks:
 *   - All 10 requests hit the database together
 *   - 2-3 might pass validation before any write completes
 *   - Same trucks assigned to multiple transporters
 *   - Manual cleanup, angry users, broken trust
 * 
 * This is called a RACE CONDITION.
 * 
 * THE SOLUTION (Atomic DB Claim + Hold Ledger):
 * ─────────────────────────────────────────────
 * - Claim candidate rows with FOR UPDATE SKIP LOCKED inside a transaction
 * - Transition exactly N rows from searching -> held with owner preconditions
 * - Persist hold ledger for recovery/idempotent replay
 * - Use Redis only for optional fast-path caching/cleanup
 * 
 * SCALABILITY:
 * ────────────
 * - Multiple backend servers? DB transaction semantics remain consistent
 * - Server crashes? Hold ledger + TTL cleanup reconciles stale holds
 * - Redis interruptions do not break correctness
 * - No double booking across concurrent hold races
 * 
 * FLOW:
 * ─────
 * 1. Transporter taps "Accept" → holdTrucks()
 *    a. Atomic DB claim of exact requested quantity
 *    b. If insufficient/changed state → deterministic failure
 *    c. Persist hold ledger with expiry for recovery
 *    d. Broadcast availability update
 * 
 * 2. Transporter confirms → confirmHold()
 *    a. Verify hold exists and is valid
 *    b. Mark trucks as permanently assigned
 *    c. Release/let locks expire
 * 
 * 3. Timeout or reject → releaseHold()
 *    a. Reconcile held rows with order state guards
 *    b. Update hold ledger terminal status
 *    c. System broadcasts update
 * 
 * WHAT HAPPENS IF:
 * ────────────────
 * - Response lost after success? Idempotency + my-active reconciliation returns same hold
 * - Server crashes mid-flow? Ledger cleanup reconciles stale active holds
 * - Cancel-vs-hold race? Terminal order states win during confirm/release checks
 * 
 * NEVER DO THIS:
 * ──────────────
 * ❌ Read availability and trust app timing without transactional claim
 * ❌ Return hold success before exact row-state transition commits
 * ❌ Re-open cancelled/expired rows to searching on release
 * ❌ Process requests without any locking
 * 
 * @author Weelo Team
 * @version 2.0.0 (Redis-powered for production scale)
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '../../shared/database/db';
import { prismaClient, withDbTimeout, AssignmentStatus, OrderStatus, TruckRequestStatus, VehicleStatus } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { liveAvailabilityService } from '../../shared/services/live-availability.service';
import { queueService } from '../../shared/services/queue.service';
import { metrics } from '../../shared/monitoring/metrics.service';
import { fcmService } from '../../shared/services/fcm.service';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Status of a truck in the system
 */
/**
 * Truck status for the hold system
 * Note: Maps to TruckRequestRecord status in db.ts
 * - 'searching' = available for transporters to hold
 * - 'held' = temporarily held (180 sec / 3 minute timer)
 * - 'assigned' = confirmed, waiting for driver assignment
 */
export type TruckStatus = 'searching' | 'held' | 'assigned' | 'in_transit' | 'completed';

/**
 * Hold record - tracks who is holding which trucks
 */
export interface TruckHold {
  holdId: string;
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  truckRequestIds: string[];      // Which specific truck requests are held
  createdAt: Date;
  expiresAt: Date;
  status: 'active' | 'confirmed' | 'expired' | 'released';
}

/**
 * Request to hold trucks
 */
export interface HoldTrucksRequest {
  orderId: string;
  transporterId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  idempotencyKey?: string;
}

/**
 * Response from hold operation
 */
export interface HoldTrucksResponse {
  success: boolean;
  holdId?: string;
  expiresAt?: Date;
  heldQuantity?: number;
  holdState?: 'reserved' | 'released' | 'confirmed';
  eventId?: string;
  eventVersion?: number;
  serverTimeMs?: number;
  message: string;
  error?: string;
}

/**
 * Truck availability for a vehicle type
 */
export interface TruckAvailability {
  vehicleType: string;
  vehicleSubtype: string;
  totalNeeded: number;
  available: number;
  held: number;
  assigned: number;
  farePerTruck: number;
}

/**
 * Order availability response
 */
export interface OrderAvailability {
  orderId: string;
  customerName: string;
  customerPhone: string;
  pickup: any;
  drop: any;
  distanceKm: number;
  goodsType: string;
  trucks: TruckAvailability[];
  totalValue: number;
  isFullyAssigned: boolean;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Hold configuration - easy to adjust
 */
const CONFIG = {
  // Keep enough time for transporter to map vehicles + drivers before confirm.
  HOLD_DURATION_SECONDS: 180,      // 3 minutes hold window
  CLEANUP_INTERVAL_MS: 5000,       // How often to clean expired holds
  MAX_HOLD_QUANTITY: 50,           // Max trucks one transporter can hold at once
  MIN_HOLD_QUANTITY: 1,            // Minimum trucks to hold
};

const ACTIVE_ORDER_STATUSES = new Set(['created', 'broadcasting', 'active', 'partially_filled']);
const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'expired', 'completed', 'fully_filled']);
const HOLD_EVENT_VERSION = 1;

const FF_HOLD_DB_ATOMIC_CLAIM = process.env.FF_HOLD_DB_ATOMIC_CLAIM !== 'false';
const FF_HOLD_STRICT_IDEMPOTENCY = process.env.FF_HOLD_STRICT_IDEMPOTENCY !== 'false';
const FF_HOLD_RECONCILE_RECOVERY = process.env.FF_HOLD_RECONCILE_RECOVERY !== 'false';
const FF_HOLD_SAFE_RELEASE_GUARD = process.env.FF_HOLD_SAFE_RELEASE_GUARD !== 'false';
const HOLD_IDEMPOTENCY_RETENTION_HOURS = Math.max(24, parseInt(process.env.HOLD_IDEMPOTENCY_RETENTION_HOURS || '168', 10) || 168);
const HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS || String(30 * 60 * 1000), 10) || (30 * 60 * 1000)
);

// =============================================================================
// REDIS KEYS - Distributed Locking for Truck Holds
// =============================================================================

/**
 * Redis key patterns for truck holds
 * 
 * WHY REDIS IS MANDATORY HERE:
 * - Prevents double assignment (race conditions)
 * - Atomic SETNX operations for locking
 * - TTL auto-releases locks (no manual cleanup)
 * - Works across multiple server instances
 * 
 * KEY PATTERNS:
 * - hold:{holdId}                    → Hold data (JSON, TTL: 180s / 3 min)
 * - hold:order:{orderId}             → Set of holdIds for this order
 * - hold:transporter:{transporterId} → Set of holdIds for this transporter
 * - lock:truck:{truckRequestId}      → Lock for specific truck (SETNX)
 */
const REDIS_KEYS = {
  HOLD: (holdId: string) => `hold:${holdId}`,
  HOLDS_BY_ORDER: (orderId: string) => `hold:order:${orderId}`,
  HOLDS_BY_TRANSPORTER: (transporterId: string) => `hold:transporter:${transporterId}`,
  TRUCK_LOCK: (truckRequestId: string) => `lock:truck:${truckRequestId}`,
};

// =============================================================================
// REDIS-POWERED HOLD STORE
// =============================================================================

/**
 * Redis-backed holds store for distributed locking
 * 
 * CRITICAL FOR SCALABILITY:
 * - Atomic operations prevent race conditions
 * - TTL auto-expires holds (no cleanup needed)
 * - Works across multiple server instances
 * - Survives server restarts
 */
class HoldStore {

  /**
   * Add a new hold with distributed lock
   * Uses Redis SETNX for atomic "hold or fail" semantics
   */
  async add(hold: TruckHold): Promise<boolean> {
    try {
      // 1. Try to acquire locks for all truck requests atomically
      // Sort IDs to prevent deadlocks when concurrent requests lock same trucks in different orders
      const sortedTruckIds = [...hold.truckRequestIds].sort();
      const lockResults: boolean[] = [];

      for (const truckId of sortedTruckIds) {
        const lockKey = REDIS_KEYS.TRUCK_LOCK(truckId);
        const lockResult = await redisService.acquireLock(
          lockKey.replace('lock:', ''), // acquireLock adds 'lock:' prefix
          hold.transporterId,
          CONFIG.HOLD_DURATION_SECONDS
        );
        lockResults.push(lockResult.acquired);

        if (!lockResult.acquired) {
          // Someone else got this truck - release any locks we got (in same sorted order)
          for (let i = 0; i < lockResults.length - 1; i++) {
            if (lockResults[i]) {
              await redisService.releaseLock(
                REDIS_KEYS.TRUCK_LOCK(sortedTruckIds[i]).replace('lock:', ''),
                hold.transporterId
              );
            }
          }
          // 50ms backoff before caller can retry (reduces contention)
          await new Promise(resolve => setTimeout(resolve, 50));
          logger.warn(`[HoldStore] Failed to acquire lock for truck ${truckId}`);
          return false;
        }
      }

      // 2. All locks acquired - store hold data
      const holdData: TruckHoldRedis = {
        ...hold,
        createdAt: hold.createdAt.toISOString(),
        expiresAt: hold.expiresAt.toISOString(),
      };

      await redisService.setJSON(
        REDIS_KEYS.HOLD(hold.holdId),
        holdData,
        CONFIG.HOLD_DURATION_SECONDS + 5 // Extra buffer for cleanup
      );

      // 3. Add to order index
      await redisService.sAdd(REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId), hold.holdId);
      await redisService.expire(REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId), CONFIG.HOLD_DURATION_SECONDS + 60);

      // 4. Add to transporter index
      await redisService.sAdd(REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId), hold.holdId);
      await redisService.expire(REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId), CONFIG.HOLD_DURATION_SECONDS + 60);

      logger.info(`[HoldStore] ✅ Hold ${hold.holdId} stored with ${hold.truckRequestIds.length} truck locks`);
      return true;

    } catch (error: any) {
      logger.error(`[HoldStore] Failed to add hold: ${error.message}`);
      return false;
    }
  }

  /**
   * Get hold by ID
   */
  async get(holdId: string): Promise<TruckHold | undefined> {
    try {
      const data = await redisService.getJSON<TruckHoldRedis>(REDIS_KEYS.HOLD(holdId));
      if (!data) return undefined;

      return {
        ...data,
        createdAt: new Date(data.createdAt),
        expiresAt: new Date(data.expiresAt),
      };
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Update hold status
   */
  async updateStatus(holdId: string, status: TruckHold['status']): Promise<void> {
    try {
      const hold = await this.get(holdId);
      if (!hold) return;

      hold.status = status;

      const holdData: TruckHoldRedis = {
        ...hold,
        createdAt: hold.createdAt.toISOString(),
        expiresAt: hold.expiresAt.toISOString(),
      };

      // Get remaining TTL
      const ttl = await redisService.ttl(REDIS_KEYS.HOLD(holdId));
      await redisService.setJSON(REDIS_KEYS.HOLD(holdId), holdData, ttl > 0 ? ttl : 60);

    } catch (error: any) {
      logger.error(`[HoldStore] Failed to update status: ${error.message}`);
    }
  }

  /**
   * Remove a hold and release all locks
   */
  async remove(holdId: string): Promise<void> {
    try {
      const hold = await this.get(holdId);
      if (!hold) return;

      // Release all truck locks
      for (const truckId of hold.truckRequestIds) {
        await redisService.releaseLock(
          REDIS_KEYS.TRUCK_LOCK(truckId).replace('lock:', ''),
          hold.transporterId
        );
      }

      // Remove from indexes
      await redisService.sRem(REDIS_KEYS.HOLDS_BY_ORDER(hold.orderId), holdId);
      await redisService.sRem(REDIS_KEYS.HOLDS_BY_TRANSPORTER(hold.transporterId), holdId);

      // Delete hold data
      await redisService.del(REDIS_KEYS.HOLD(holdId));

      logger.info(`[HoldStore] Hold ${holdId} removed, locks released`);

    } catch (error: any) {
      logger.error(`[HoldStore] Failed to remove hold: ${error.message}`);
    }
  }

  /**
   * Get all active holds for an order
   */
  async getActiveHoldsByOrder(orderId: string): Promise<TruckHold[]> {
    try {
      const holdIds = await redisService.sMembers(REDIS_KEYS.HOLDS_BY_ORDER(orderId));
      const activeHolds: TruckHold[] = [];

      for (const holdId of holdIds) {
        const hold = await this.get(holdId);
        if (hold && hold.status === 'active' && new Date(hold.expiresAt) > new Date()) {
          activeHolds.push(hold);
        }
      }

      return activeHolds;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get all expired holds (for cleanup)
   * Note: With Redis TTL, this is mostly for manual cleanup
   */
  async getExpiredHolds(): Promise<TruckHold[]> {
    // Redis TTL handles expiration automatically
    // This method is kept for compatibility but returns empty
    return [];
  }

  /**
   * Get active hold by transporter for a specific order/vehicle type
   */
  async getTransporterHold(
    transporterId: string,
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string
  ): Promise<TruckHold | undefined> {
    try {
      const holdIds = await redisService.sMembers(REDIS_KEYS.HOLDS_BY_TRANSPORTER(transporterId));

      for (const holdId of holdIds) {
        const hold = await this.get(holdId);
        if (
          hold &&
          hold.status === 'active' &&
          hold.orderId === orderId &&
          hold.vehicleType.toLowerCase() === vehicleType.toLowerCase() &&
          hold.vehicleSubtype.toLowerCase() === vehicleSubtype.toLowerCase() &&
          new Date(hold.expiresAt) > new Date()
        ) {
          return hold;
        }
      }

      return undefined;
    } catch (error) {
      return undefined;
    }
  }
}

/**
 * Redis-serializable hold data (dates as strings)
 */
interface TruckHoldRedis extends Omit<TruckHold, 'createdAt' | 'expiresAt'> {
  createdAt: string;
  expiresAt: string;
}

// Singleton store instance
const holdStore = new HoldStore();

// =============================================================================
// TRUCK HOLD SERVICE
// =============================================================================

class TruckHoldService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private lastIdempotencyPurgeAtMs = 0;

  constructor() {
    this.startCleanupJob();
  }

  private normalizeVehiclePart(value: string | null | undefined): string {
    return (value || '').trim();
  }

  private buildOperationPayloadHash(operation: 'hold' | 'release', payload: Record<string, unknown>): string {
    return crypto
      .createHash('sha256')
      .update(`${operation}:${JSON.stringify(payload)}`)
      .digest('hex');
  }

  private async getIdempotentOperationResponse(
    transporterId: string,
    operation: 'hold' | 'release',
    idempotencyKey?: string
  ): Promise<{
    statusCode: number;
    response: HoldTrucksResponse | { success: boolean; message: string; error?: string };
    payloadHash: string;
  } | null> {
    if (!FF_HOLD_STRICT_IDEMPOTENCY || !idempotencyKey) return null;

    const existing = await prismaClient.truckHoldIdempotency.findUnique({
      where: {
        transporterId_operation_idempotencyKey: {
          transporterId,
          operation,
          idempotencyKey
        }
      }
    });

    if (!existing) return null;

    return {
      statusCode: existing.statusCode,
      response: existing.responseJson as unknown as HoldTrucksResponse | { success: boolean; message: string; error?: string },
      payloadHash: existing.payloadHash
    };
  }

  private async saveIdempotentOperationResponse(
    transporterId: string,
    operation: 'hold' | 'release',
    idempotencyKey: string | undefined,
    payloadHash: string,
    statusCode: number,
    response: HoldTrucksResponse | { success: boolean; message: string; error?: string }
  ): Promise<void> {
    if (!FF_HOLD_STRICT_IDEMPOTENCY || !idempotencyKey) return;

    await prismaClient.truckHoldIdempotency.upsert({
      where: {
        transporterId_operation_idempotencyKey: {
          transporterId,
          operation,
          idempotencyKey
        }
      },
      update: {
        payloadHash,
        statusCode,
        responseJson: response as unknown as Prisma.InputJsonValue
      },
      create: {
        id: uuidv4(),
        transporterId,
        operation,
        idempotencyKey,
        payloadHash,
        statusCode,
        responseJson: response as unknown as Prisma.InputJsonValue
      }
    });
  }

  private async findActiveLedgerHold(
    transporterId: string,
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string
  ) {
    const now = new Date();
    return prismaClient.truckHoldLedger.findFirst({
      where: {
        transporterId,
        orderId,
        vehicleType: { equals: vehicleType, mode: 'insensitive' },
        vehicleSubtype: { equals: vehicleSubtype, mode: 'insensitive' },
        status: 'active',
        expiresAt: { gt: now }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  private recordHoldOutcomeMetrics(result: HoldTrucksResponse, startedAtMs: number, replay: boolean = false): void {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    metrics.observeHistogram('hold.latency_ms', durationMs, {
      replay: replay ? 'true' : 'false',
      result: result.success ? 'success' : 'failed'
    });
    if (replay) {
      metrics.incrementCounter('hold.idempotent_replay.total', {
        result: result.success ? 'success' : 'failed',
        reason: (result.error || 'none').toLowerCase()
      });
      return;
    }
    if (result.success) {
      metrics.incrementCounter('hold.success.total');
    } else {
      const reason = (result.error || 'unknown').toLowerCase();
      metrics.incrementCounter('hold.conflict.total', { reason });
    }
  }

  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================

  /**
   * HOLD TRUCKS
   * -----------
   * Called when transporter clicks "Accept X trucks"
   * 
   * 1. Validates request
   * 2. Checks availability
   * 3. Marks truck requests as "held"
   * 4. Creates hold record with TTL
   * 5. Broadcasts update to all transporters
   * 
   * @param request - Hold request details
   * @returns HoldTrucksResponse
   */
  async holdTrucks(request: HoldTrucksRequest): Promise<HoldTrucksResponse> {
    const holdStartedAtMs = Date.now();
    metrics.incrementCounter('hold.request.total');

    const transporterId = request.transporterId;
    const orderId = (request.orderId || '').trim();
    const vehicleType = this.normalizeVehiclePart(request.vehicleType);
    const vehicleSubtype = this.normalizeVehiclePart(request.vehicleSubtype);
    const quantity = Number(request.quantity);
    const idempotencyKey = request.idempotencyKey?.trim() || undefined;

    logger.info(`[TruckHold] Hold request: ${quantity}x ${vehicleType} ${vehicleSubtype} for order ${orderId}`);

    const payloadHash = this.buildOperationPayloadHash('hold', {
      orderId,
      vehicleType: vehicleType.toLowerCase(),
      vehicleSubtype: vehicleSubtype.toLowerCase(),
      quantity
    });

    const idempotentReplay = await this.getIdempotentOperationResponse(
      transporterId,
      'hold',
      idempotencyKey
    );
    if (idempotentReplay) {
      if (idempotentReplay.payloadHash !== payloadHash) {
        const conflict = {
          success: false,
          message: 'Idempotency key reused with a different hold payload.',
          error: 'IDEMPOTENCY_CONFLICT'
        };
        this.recordHoldOutcomeMetrics(conflict, holdStartedAtMs, true);
        return conflict;
      }
      const replayResponse = idempotentReplay.response as HoldTrucksResponse;
      this.recordHoldOutcomeMetrics(replayResponse, holdStartedAtMs, true);
      return replayResponse;
    }

    const eventId = uuidv4();
    const serverTimeMs = Date.now();
    let response: HoldTrucksResponse;
    let statusCode = 400;

    try {
      if (!orderId || !vehicleType || !Number.isFinite(quantity)) {
        response = {
          success: false,
          message: 'orderId, vehicleType and finite quantity are required.',
          error: 'VALIDATION_ERROR'
        };
        await this.saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
        this.recordHoldOutcomeMetrics(response, holdStartedAtMs);
        return response;
      }

      if (!Number.isInteger(quantity) || quantity < CONFIG.MIN_HOLD_QUANTITY || quantity > CONFIG.MAX_HOLD_QUANTITY) {
        response = {
          success: false,
          message: `Quantity must be an integer between ${CONFIG.MIN_HOLD_QUANTITY} and ${CONFIG.MAX_HOLD_QUANTITY}.`,
          error: 'VALIDATION_ERROR'
        };
        await this.saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
        this.recordHoldOutcomeMetrics(response, holdStartedAtMs);
        return response;
      }

      if (FF_HOLD_RECONCILE_RECOVERY) {
        const existingHold = await this.findActiveLedgerHold(transporterId, orderId, vehicleType, vehicleSubtype);
        if (existingHold) {
          statusCode = 200;
          response = {
            success: true,
            holdId: existingHold.holdId,
            expiresAt: existingHold.expiresAt,
            heldQuantity: existingHold.quantity,
            holdState: 'reserved',
            eventId,
            eventVersion: HOLD_EVENT_VERSION,
            serverTimeMs,
            message: `${existingHold.quantity} truck(s) already reserved for this request.`
          };
          await this.saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
          this.recordHoldOutcomeMetrics(response, holdStartedAtMs, true);
          return response;
        }
      }

      const holdId = `HOLD_${uuidv4().substring(0, 8).toUpperCase()}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + CONFIG.HOLD_DURATION_SECONDS * 1000);
      let heldCount = 0;

      await withDbTimeout(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: { id: true, status: true }
        });

        if (!order) throw new Error('ORDER_NOT_FOUND');
        if (TERMINAL_ORDER_STATUSES.has(order.status)) throw new Error('ORDER_INACTIVE');

        const claimedRows = FF_HOLD_DB_ATOMIC_CLAIM
          ? await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id
              FROM "TruckRequest"
              WHERE "orderId" = ${orderId}
                AND lower("vehicleType") = lower(${vehicleType})
                AND lower("vehicleSubtype") = lower(${vehicleSubtype})
                AND "status" = 'searching'
              ORDER BY "requestNumber" ASC, "createdAt" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT ${quantity}
            `
          : await tx.truckRequest.findMany({
            where: {
              orderId,
              vehicleType: { equals: vehicleType, mode: 'insensitive' },
              vehicleSubtype: { equals: vehicleSubtype, mode: 'insensitive' },
              status: TruckRequestStatus.searching
            },
            orderBy: [{ requestNumber: 'asc' }, { createdAt: 'asc' }],
            take: quantity,
            select: { id: true }
          });

        const selectedIds = claimedRows.map((row) => row.id);
        if (selectedIds.length < quantity) {
          throw new Error(`NOT_ENOUGH_AVAILABLE:${selectedIds.length}`);
        }

        const claimUpdate = await tx.truckRequest.updateMany({
          where: {
            id: { in: selectedIds },
            orderId,
            status: TruckRequestStatus.searching
          },
          data: {
            status: TruckRequestStatus.held,
            heldById: transporterId,
            heldAt: now.toISOString()
          }
        });

        if (claimUpdate.count !== quantity) {
          throw new Error('TRUCK_STATE_CHANGED');
        }

        await tx.truckHoldLedger.create({
          data: {
            holdId,
            orderId,
            transporterId,
            vehicleType,
            vehicleSubtype,
            quantity,
            truckRequestIds: selectedIds,
            status: 'active',
            expiresAt
          }
        });

        heldCount = claimUpdate.count;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeoutMs: 8000
      });

      response = {
        success: true,
        holdId,
        expiresAt,
        heldQuantity: heldCount,
        holdState: 'reserved',
        eventId,
        eventVersion: HOLD_EVENT_VERSION,
        serverTimeMs,
        message: `${heldCount} truck(s) reserved for ${CONFIG.HOLD_DURATION_SECONDS} seconds. Assign drivers to finalize.`
      };
      statusCode = 200;

      this.broadcastAvailabilityUpdate(orderId);
      logger.info(`[TruckHold] ✅ Held ${heldCount} trucks. Hold ID: ${holdId}, Expires: ${expiresAt.toISOString()}`);
    } catch (error: any) {
      const message = String(error?.message || 'HOLD_FAILED');
      if (message.startsWith('NOT_ENOUGH_AVAILABLE')) {
        const available = parseInt(message.split(':')[1] || '0', 10);
        response = {
          success: false,
          message: `Only ${available} trucks available right now.`,
          error: 'NOT_ENOUGH_AVAILABLE'
        };
      } else if (message === 'ORDER_NOT_FOUND') {
        response = {
          success: false,
          message: 'This request no longer exists.',
          error: 'ORDER_INACTIVE'
        };
      } else if (message === 'ORDER_INACTIVE') {
        response = {
          success: false,
          message: 'This request is no longer active.',
          error: 'ORDER_INACTIVE'
        };
      } else if (message === 'TRUCK_STATE_CHANGED') {
        response = {
          success: false,
          message: 'Truck availability changed. Please retry.',
          error: 'TRUCK_STATE_CHANGED'
        };
      } else {
        logger.error(`[TruckHold] Error holding trucks: ${message}`, error);
        response = {
          success: false,
          message: 'Failed to reserve trucks. Please retry.',
          error: 'INTERNAL_ERROR'
        };
      }
    }

    await this.saveIdempotentOperationResponse(transporterId, 'hold', idempotencyKey, payloadHash, statusCode, response);
    this.recordHoldOutcomeMetrics(response, holdStartedAtMs);
    return response;
  }

  /**
   * CONFIRM HOLD (Simple)
   * ---------------------
   * Called when transporter confirms their selection within the hold period.
   * This is the SIMPLE version - just confirms the hold without vehicle/driver assignment.
   * Use confirmHoldWithAssignments() for full assignment flow.
   * 
   * 1. Validates hold exists and is active
   * 2. Marks trucks as "assigned"
   * 3. Marks hold as "confirmed"
   * 4. Broadcasts update
   * 
   * @param holdId - The hold ID to confirm
   * @param transporterId - The transporter confirming
   * @returns Success/failure response
   */
  async confirmHold(holdId: string, transporterId: string): Promise<{ success: boolean; message: string; assignedTrucks?: string[] }> {
    const confirmStartedAtMs = Date.now();
    logger.info(`[TruckHold] Simple confirm request: ${holdId} by ${transporterId}`);

    try {
      const hold = await prismaClient.truckHoldLedger.findUnique({ where: { holdId } });

      if (!hold) {
        return { success: false, message: 'Hold not found or expired' };
      }

      if (hold.transporterId !== transporterId) {
        return { success: false, message: 'This hold belongs to another transporter' };
      }

      if (hold.status !== 'active') {
        return { success: false, message: `Hold is ${hold.status}. Cannot confirm.` };
      }

      if (hold.expiresAt <= new Date()) {
        // Release the hold
        await this.releaseHold(holdId, transporterId);
        return { success: false, message: 'Hold expired. Please try again.' };
      }

      const now = new Date().toISOString();
      const confirmed = await withDbTimeout(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: hold.orderId },
          select: { status: true, id: true }
        });
        if (!order || TERMINAL_ORDER_STATUSES.has(order.status)) {
          throw new Error('ORDER_INACTIVE');
        }

        const update = await tx.truckRequest.updateMany({
          where: {
            id: { in: hold.truckRequestIds },
            orderId: hold.orderId,
            status: TruckRequestStatus.held,
            heldById: transporterId
          },
          data: {
            status: TruckRequestStatus.assigned,
            assignedTransporterId: transporterId,
            assignedAt: now,
            heldById: null,
            heldAt: null
          }
        });

        if (update.count !== hold.quantity) {
          throw new Error('TRUCK_STATE_CHANGED');
        }

        await tx.order.update({
          where: { id: hold.orderId },
          data: { trucksFilled: { increment: hold.quantity } }
        });

        await tx.truckHoldLedger.update({
          where: { holdId },
          data: {
            status: 'confirmed',
            confirmedAt: new Date(),
            terminalReason: null
          }
        });

        return update.count;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeoutMs: 8000
      });

      // 5. Broadcast update
      this.broadcastAvailabilityUpdate(hold.orderId);

      logger.info(`[TruckHold] ✅ Confirmed hold ${holdId}. ${confirmed} trucks assigned to ${transporterId}`);

      return {
        success: true,
        message: `${hold.quantity} truck(s) assigned successfully. Please assign drivers.`,
        assignedTrucks: hold.truckRequestIds
      };

    } catch (error: any) {
      if (String(error?.message || '') === 'ORDER_INACTIVE') {
        return { success: false, message: 'This request is no longer active.' };
      }
      if (String(error?.message || '') === 'TRUCK_STATE_CHANGED') {
        return { success: false, message: 'Some held trucks changed state. Please retry.' };
      }
      logger.error(`[TruckHold] Error confirming hold: ${error.message}`, error);
      return { success: false, message: 'Failed to confirm. Please try again.' };
    } finally {
      metrics.observeHistogram('confirm.latency_ms', Math.max(0, Date.now() - confirmStartedAtMs));
    }
  }

  /**
   * =============================================================================
   * CONFIRM HOLD WITH VEHICLE & DRIVER ASSIGNMENTS
   * =============================================================================
   * 
   * Called when transporter confirms with specific vehicle + driver for each truck.
   * This is the FULL version for production use.
   * 
   * CORE INVARIANTS ENFORCED:
   * ─────────────────────────
   * ✓ One truck can be assigned to only one active order
   * ✓ A transporter can partially fulfill a request
   * ✓ Truck count is locked atomically (via hold)
   * 
   * FLOW:
   * 1. Validate hold exists and is active
   * 2. Validate each vehicle is AVAILABLE (not in another trip)
   * 3. Validate each driver is AVAILABLE (not on another trip)
   * 4. Create assignment records
   * 5. Update vehicle status to 'in_transit'
   * 6. Notify drivers & customer
   * 7. Broadcast availability update
   * 
   * @param holdId - The hold ID to confirm
   * @param transporterId - The transporter confirming
   * @param assignments - Array of { vehicleId, driverId } for each truck
   * @returns Success/failure with assignment details
   */
  async confirmHoldWithAssignments(
    holdId: string,
    transporterId: string,
    assignments: Array<{ vehicleId: string; driverId: string }>
  ): Promise<{
    success: boolean;
    message: string;
    assignmentIds?: string[];
    tripIds?: string[];
    failedAssignments?: Array<{ vehicleId: string; reason: string }>;
  }> {
    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  🔒 CONFIRM HOLD WITH ASSIGNMENTS                            ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Hold ID: ${holdId}`);
    logger.info(`║  Transporter: ${transporterId}`);
    logger.info(`║  Assignments: ${assignments.length}`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    try {
      // =========================================================================
      // STEP 1: Validate hold exists and is active
      // =========================================================================
      const hold = await prismaClient.truckHoldLedger.findUnique({ where: { holdId } });

      if (!hold) {
        return { success: false, message: 'Hold not found or expired' };
      }

      if (hold.transporterId !== transporterId) {
        return { success: false, message: 'This hold belongs to another transporter' };
      }

      if (hold.status !== 'active') {
        return { success: false, message: `Hold is ${hold.status}. Cannot confirm.` };
      }

      if (hold.expiresAt <= new Date()) {
        await this.releaseHold(holdId, transporterId);
        return { success: false, message: 'Hold expired. Please try again.' };
      }

      // Validate assignment count matches hold
      if (assignments.length !== hold.quantity) {
        return {
          success: false,
          message: `Expected ${hold.quantity} assignments but got ${assignments.length}`
        };
      }

      // =========================================================================
      // STEP 2: Validate all vehicles are AVAILABLE
      // =========================================================================
      // CORE INVARIANT: One truck can be assigned to only one active order
      // =========================================================================
      const failedAssignments: Array<{ vehicleId: string; reason: string }> = [];
      const validatedVehicles: Array<{ vehicle: any; driver: any; truckRequestId: string }> = [];
      const activeDriverStatuses: AssignmentStatus[] = [
        AssignmentStatus.pending,
        AssignmentStatus.driver_accepted,
        AssignmentStatus.en_route_pickup,
        AssignmentStatus.at_pickup,
        AssignmentStatus.in_transit
      ];
      const seenVehicleIds = new Set<string>();
      const seenDriverIds = new Set<string>();
      const vehicleIds = assignments.map((assignment) => assignment.vehicleId);
      const driverIds = assignments.map((assignment) => assignment.driverId);
      const uniqueVehicleIds = Array.from(new Set(vehicleIds));
      const uniqueDriverIds = Array.from(new Set(driverIds));

      const [vehicleRows, driverRows, activeDriverAssignments] = await Promise.all([
        prismaClient.vehicle.findMany({
          where: { id: { in: uniqueVehicleIds } },
          select: {
            id: true,
            transporterId: true,
            status: true,
            currentTripId: true,
            vehicleType: true,
            vehicleSubtype: true,
            vehicleNumber: true
          }
        }),
        prismaClient.user.findMany({
          where: { id: { in: uniqueDriverIds } },
          select: {
            id: true,
            name: true,
            phone: true,
            transporterId: true
          }
        }),
        prismaClient.assignment.findMany({
          where: {
            driverId: { in: uniqueDriverIds },
            status: { in: activeDriverStatuses }
          },
          select: {
            driverId: true,
            tripId: true
          }
        })
      ]);

      const vehicleMap = new Map(vehicleRows.map((vehicle) => [vehicle.id, vehicle]));
      const driverMap = new Map(driverRows.map((driver) => [driver.id, driver]));
      const activeDriverMap = new Map(activeDriverAssignments.map((assignment) => [assignment.driverId, assignment]));

      for (let i = 0; i < assignments.length; i++) {
        const { vehicleId, driverId } = assignments[i];
        const truckRequestId = hold.truckRequestIds[i];

        if (seenVehicleIds.has(vehicleId)) {
          failedAssignments.push({ vehicleId, reason: 'Duplicate vehicle in request payload' });
          continue;
        }
        seenVehicleIds.add(vehicleId);

        if (seenDriverIds.has(driverId)) {
          failedAssignments.push({ vehicleId, reason: 'Duplicate driver in request payload' });
          continue;
        }
        seenDriverIds.add(driverId);

        const vehicle = vehicleMap.get(vehicleId);
        if (!vehicle) {
          failedAssignments.push({ vehicleId, reason: 'Vehicle not found' });
          continue;
        }

        if (vehicle.transporterId !== transporterId) {
          failedAssignments.push({ vehicleId, reason: 'Vehicle does not belong to you' });
          continue;
        }

        if (vehicle.status !== 'available') {
          failedAssignments.push({
            vehicleId,
            reason: `Vehicle is ${vehicle.status}${vehicle.currentTripId ? ` (Trip: ${vehicle.currentTripId})` : ''}`
          });
          continue;
        }

        if (vehicle.vehicleType.toLowerCase() !== hold.vehicleType.toLowerCase()) {
          failedAssignments.push({
            vehicleId,
            reason: `Vehicle type mismatch. Expected ${hold.vehicleType}, got ${vehicle.vehicleType}`
          });
          continue;
        }

        // Subtype enforcement: prevent e.g. 10-wheel assigned to 6-wheel slot
        if (hold.vehicleSubtype && vehicle.vehicleSubtype &&
          vehicle.vehicleSubtype.toLowerCase() !== hold.vehicleSubtype.toLowerCase()) {
          failedAssignments.push({
            vehicleId,
            reason: `Vehicle subtype mismatch. Expected ${hold.vehicleSubtype}, got ${vehicle.vehicleSubtype}`
          });
          continue;
        }

        const driver = driverMap.get(driverId);
        if (!driver) {
          failedAssignments.push({ vehicleId, reason: 'Driver not found' });
          continue;
        }

        if (driver.transporterId !== transporterId && driver.id !== transporterId) {
          failedAssignments.push({ vehicleId, reason: 'Driver does not belong to you' });
          continue;
        }

        const activeAssignment = activeDriverMap.get(driverId);
        if (activeAssignment) {
          failedAssignments.push({
            vehicleId,
            reason: `Driver ${driver.name} is already on trip ${activeAssignment.tripId}`
          });
          continue;
        }

        validatedVehicles.push({ vehicle, driver, truckRequestId });
      }

      // If ANY assignment failed, reject the whole batch
      // This maintains atomicity - either all succeed or none
      if (failedAssignments.length > 0) {
        logger.warn(`[TruckHold] ❌ ${failedAssignments.length} assignments failed validation`);
        failedAssignments.forEach(f => logger.warn(`   - ${f.vehicleId}: ${f.reason}`));

        return {
          success: false,
          message: `${failedAssignments.length} assignment(s) failed validation`,
          failedAssignments
        };
      }

      // =========================================================================
      // STEP 3: All validations passed - Create assignments atomically
      // =========================================================================
      const order = await db.getOrderById(hold.orderId);
      if (!order) {
        return { success: false, message: 'Order not found' };
      }

      const transporter = await db.getUserById(transporterId);
      const now = new Date().toISOString();
      const confirmedAssignments = await withDbTimeout(async (tx) => {
        const txAssignments: Array<{
          assignmentId: string;
          tripId: string;
          truckRequestId: string;
          vehicle: any;
          driver: any;
          farePerTruck: number;
        }> = [];

        const currentOrder = await tx.order.findUnique({
          where: { id: hold.orderId },
          select: { id: true, totalTrucks: true, trucksFilled: true }
        });
        if (!currentOrder) {
          throw new Error('ORDER_NOT_FOUND');
        }

        const txTruckRequests = await tx.truckRequest.findMany({
          where: {
            id: { in: hold.truckRequestIds },
            orderId: hold.orderId
          },
          select: {
            id: true,
            orderId: true,
            status: true,
            heldById: true,
            pricePerTruck: true
          }
        });
        const txTruckRequestMap = new Map(txTruckRequests.map((truckRequest) => [truckRequest.id, truckRequest]));
        if (txTruckRequests.length !== hold.truckRequestIds.length) {
          throw new Error('TRUCK_REQUEST_NOT_FOUND');
        }

        const txBusyDrivers = await tx.assignment.findMany({
          where: {
            driverId: { in: uniqueDriverIds },
            status: { in: activeDriverStatuses }
          },
          select: {
            driverId: true,
            tripId: true
          }
        });
        if (txBusyDrivers.length > 0) {
          const busyDriver = txBusyDrivers[0];
          throw new Error(`DRIVER_BUSY:${busyDriver.driverId}:${busyDriver.tripId}`);
        }

        for (const { vehicle, driver, truckRequestId } of validatedVehicles) {
          const truckRequest = txTruckRequestMap.get(truckRequestId);
          if (!truckRequest || truckRequest.orderId !== hold.orderId) {
            throw new Error(`TRUCK_REQUEST_NOT_FOUND:${truckRequestId}`);
          }
          if (truckRequest.status !== 'held' || truckRequest.heldById !== transporterId) {
            throw new Error(`TRUCK_REQUEST_NOT_HELD:${truckRequestId}`);
          }

          const assignmentId = uuidv4();
          const tripId = uuidv4();

          const vehicleUpdated = await tx.vehicle.updateMany({
            where: {
              id: vehicle.id,
              transporterId,
              status: VehicleStatus.available
            },
            data: {
              status: VehicleStatus.in_transit,
              currentTripId: tripId,
              assignedDriverId: driver.id,
              lastStatusChange: now
            }
          });
          if (vehicleUpdated.count === 0) {
            throw new Error(`VEHICLE_UNAVAILABLE:${vehicle.id}`);
          }

          const requestUpdated = await tx.truckRequest.updateMany({
            where: {
              id: truckRequestId,
              orderId: hold.orderId,
              status: TruckRequestStatus.held,
              heldById: transporterId
            },
            data: {
              status: TruckRequestStatus.assigned,
              assignedTransporterId: transporterId,
              assignedTransporterName: transporter?.name || transporter?.businessName || '',
              assignedVehicleId: vehicle.id,
              assignedVehicleNumber: vehicle.vehicleNumber,
              assignedDriverId: driver.id,
              assignedDriverName: driver.name,
              assignedDriverPhone: driver.phone || '',
              tripId,
              assignedAt: now,
              heldById: null,
              heldAt: null
            }
          });
          if (requestUpdated.count === 0) {
            throw new Error(`TRUCK_REQUEST_STATE_CHANGED:${truckRequestId}`);
          }

          await tx.assignment.create({
            data: {
              id: assignmentId,
              bookingId: null,  // New multi-truck system uses orderId + truckRequestId, not legacy Booking
              truckRequestId,
              orderId: hold.orderId,
              transporterId,
              transporterName: transporter?.name || transporter?.businessName || '',
              vehicleId: vehicle.id,
              vehicleNumber: vehicle.vehicleNumber,
              vehicleType: vehicle.vehicleType,
              vehicleSubtype: vehicle.vehicleSubtype || '',
              driverId: driver.id,
              driverName: driver.name,
              driverPhone: driver.phone || '',
              tripId,
              status: AssignmentStatus.pending,
              assignedAt: now
            }
          });

          txAssignments.push({
            assignmentId,
            tripId,
            truckRequestId,
            vehicle,
            driver,
            farePerTruck: truckRequest.pricePerTruck
          });
        }

        const updatedOrder = await tx.order.update({
          where: { id: hold.orderId },
          data: { trucksFilled: { increment: txAssignments.length } },
          select: { trucksFilled: true, totalTrucks: true }
        });
        const newStatus: OrderStatus =
          updatedOrder.trucksFilled >= updatedOrder.totalTrucks
            ? OrderStatus.fully_filled
            : OrderStatus.partially_filled;
        await tx.order.update({
          where: { id: hold.orderId },
          data: { status: newStatus }
        });

        return {
          assignments: txAssignments,
          newTrucksFilled: updatedOrder.trucksFilled,
          newStatus
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
      const assignmentIds = confirmedAssignments.assignments.map((assignment) => assignment.assignmentId);
      const tripIds = confirmedAssignments.assignments.map((assignment) => assignment.tripId);
      const newTrucksFilled = confirmedAssignments.newTrucksFilled;
      const newStatus = confirmedAssignments.newStatus;

      // Live availability: vehicles went available → in_transit AFTER transaction committed
      for (const assignment of confirmedAssignments.assignments) {
        const vKey = assignment.vehicle.vehicleKey || '';
        liveAvailabilityService.onVehicleStatusChange(
          transporterId, vKey, 'available', 'in_transit'
        ).catch(() => { });
      }

      // =========================================================================
      // STEP 4: OPTIMIZED BROADCAST NOTIFICATIONS (100K SCALE READY)
      // =========================================================================
      // SCALABILITY: Single room broadcast + batch FCM instead of 20 individual calls
      // BEFORE: 20 Socket.IO emits + 20 FCM queue operations = 40 network round trips
      // AFTER: 1 room emit + 1 batch FCM = 2 network operations (20x faster)
      // =========================================================================

      // Log all assignments for debugging
      for (const assignment of confirmedAssignments.assignments) {
        logger.info(
          `   ✅ Assignment created: ${assignment.vehicle.vehicleNumber} → ${assignment.driver.name} (Trip: ${assignment.tripId.substring(0, 8)})`
        );
      }

      // OPTIMIZATION 1: Single room broadcast to all drivers
      // All drivers receive their assignment in one message and filter by driverId
      const assignmentsData = confirmedAssignments.assignments.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        tripId: assignment.tripId,
        driverId: assignment.driver.id,
        driverName: assignment.driver.name,
        orderId: order.id,
        truckRequestId: assignment.truckRequestId,
        pickup: order.pickup,
        drop: order.drop,
        routePoints: order.routePoints,
        vehicleNumber: assignment.vehicle.vehicleNumber,
        vehicleType: assignment.vehicle.vehicleType,
        farePerTruck: assignment.farePerTruck,
        distanceKm: order.distanceKm,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        assignedAt: now,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        message: `New trip assigned! ${order.pickup.address} → ${order.drop.address}`
      }));

      // BACKWARD COMPATIBILITY AND OPTIMIZATION:
      // Emit individual trip_assigned events FIRST (for current Android app compatibility)
      // THEN emit the optimized batch event for future app updates
      // This ensures the current app works while enabling future optimization
      for (const assignment of confirmedAssignments.assignments) {
        const driverNotification = {
          type: 'trip_assigned',
          assignmentId: assignment.assignmentId,
          tripId: assignment.tripId,
          orderId: order.id,
          truckRequestId: assignment.truckRequestId,
          pickup: order.pickup,
          drop: order.drop,
          routePoints: order.routePoints,
          vehicleNumber: assignment.vehicle.vehicleNumber,
          farePerTruck: assignment.farePerTruck,
          distanceKm: order.distanceKm,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          assignedAt: now,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          message: `New trip assigned! ${order.pickup.address} → ${order.drop.address}`
        };

        // Individual emit for backward compatibility with current Android app
        socketService.emitToUser(assignment.driver.id, 'trip_assigned', driverNotification);
      }
      logger.info(`   📢 Individual trip_assigned events sent to ${assignmentsData.length} driver(s) (backward compatible)`);

      // OPTIMIZATION: Also send batch event for future app updates (optional, additive only)
      // socketService.emitToTransporterDrivers(transporterId, 'trip_assigned_batch', {
      //   transporterId,
      //   orderId: order.id,
      //   assignments: assignmentsData,
      //   totalAssignments: assignmentsData.length
      // });
      // logger.info(`   📢 Batch trip_assigned_batch event ready for future app updates`);

      // OPTIMIZATION 2: Batch FCM push (up to 500 tokens per request)
      // Get FCM tokens for all drivers in one batch operation
      const driverFcmtTokenIds = confirmedAssignments.assignments.map((a) => a.driver.id);
      const allFcmTokens: string[] = [];

      // Parallel fetch of tokens for all drivers
      await Promise.all(driverFcmtTokenIds.map(async (driverId) => {
        try {
          const tokens = await fcmService.getTokens(driverId);
          allFcmTokens.push(...tokens);
        } catch (err: any) {
          logger.warn(`FCM: Failed to get tokens for driver ${driverId}: ${err?.message || err}`);
        }
      }));

      // Single batch FCM push for all drivers
      if (allFcmTokens.length > 0) {
        await queueService.queueBatchPush(allFcmTokens, {
          title: `🚛 ${assignmentsData.length} New Trip(s) Assigned!`,
          body: `${assignmentsData.length === 1
            ? `${order.pickup.address} → ${order.drop.address}`
            : `${assignmentsData.length} trip(s) ready. Tap to view.`
          }`,
          data: {
            type: 'trips_assigned_batch',
            transporterId,
            orderId: order.id,
            assignmentCount: String(assignmentsData.length)
          }
        }).catch(err => {
          logger.warn(`FCM: Failed to queue batch push for ${allFcmTokens.length} tokens`, err);
        });
        logger.info(`   📱 Batch FCM pushed to ${allFcmTokens.length} device(s) across ${driverFcmtTokenIds.length} driver(s)`);
      } else {
        logger.warn(`   ⚠️ No FCM tokens found for ${driverFcmtTokenIds.length} driver(s) - WebSocket delivery only`);
      }

      // OPTIMIZATION 3: Schedule timeout jobs for each driver (kept separate for correctness)
      // Each driver needs independent 60-second timeout
      for (const assignment of confirmedAssignments.assignments) {
        const assignmentTimerData = {
          assignmentId: assignment.assignmentId,
          tripId: assignment.tripId,
          driverId: assignment.driver.id,
          driverName: assignment.driver.name,
          transporterId,
          vehicleId: assignment.vehicle.id,
          vehicleNumber: assignment.vehicle.vehicleNumber,
          orderId: order.id,
          truckRequestId: assignment.truckRequestId,
          createdAt: now
        };

        await queueService.scheduleAssignmentTimeout(assignmentTimerData, 60000);
        logger.info(`   ⏱️ Multi-truck timeout scheduled: ${assignment.assignmentId} (${assignment.vehicle.vehicleNumber} → ${assignment.driver.name})`);
      }

      // =========================================================================
      // STEP 6: Customer NOTIFICATION - ONLY ON DRIVER ACCEPT (PRD 7777)
      // =========================================================================
      // CUSTOMER SHOULD NOT BE NOTIFIED DURING TRUCK HOLD PROCESS
      // Customer is ONLY notified when driver ACCEPTS the trip (after driver_confirm)
      // See: tracking.service.ts → handleDriverAcceptance → emitToUser(customerId, ...)
      //
      // REMOVED: trucks_confirmed notification during hold confirmation
      // This was sending "trucks_confirmed" before driver accepted, which is wrong
      //
      // CUSTOMER NOTIFICATION FLOW:
      // 1. Transporter confirms hold → NO notification
      // 2. Driver assigned → NO notification
      // 3. Driver ACCEPTS → ✅ Customer notified (see trip_assigned flow)
      // 4. Driver declines → NO notification
      //
      // logger.info(`   ℹ️ Customer NOT notified during hold - wait for driver acceptance`);
      // =========================================================================
      // STEP 7: Mark hold as confirmed and broadcast
      // =========================================================================
      await prismaClient.truckHoldLedger.update({
        where: { holdId },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          terminalReason: null
        }
      }).catch(() => { });
      this.broadcastAvailabilityUpdate(hold.orderId);

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  ✅ HOLD CONFIRMED SUCCESSFULLY                              ║`);
      logger.info(`╠══════════════════════════════════════════════════════════════╣`);
      logger.info(`║  Assignments: ${assignmentIds.length}`);
      logger.info(`║  Order progress: ${newTrucksFilled}/${order.totalTrucks}`);
      logger.info(`║  Status: ${newStatus}`);
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      return {
        success: true,
        message: `${confirmedAssignments.assignments.length} truck(s) assigned successfully!`,
        assignmentIds,
        tripIds
      };

    } catch (error: any) {
      const msg = String(error?.message || '');
      logger.error(`[TruckHold] Error confirming with assignments: ${msg}`, error);

      // Prisma unique constraint violation (P2002) — driver already has an active assignment
      if (error?.code === 'P2002') {
        const target = Array.isArray(error?.meta?.target) ? error.meta.target.join(', ') : '';
        if (target.includes('driverId')) {
          return { success: false, message: 'This driver already has an active assignment. Please choose a different driver.' };
        }
        return { success: false, message: `Duplicate assignment conflict (${target}). Please try again.` };
      }

      // Prisma serialization failure (P2034) — concurrent transaction conflict
      if (error?.code === 'P2034') {
        return { success: false, message: 'Another transaction is in progress. Please try again in a moment.' };
      }

      // Known thrown errors from within the transaction
      if (msg.startsWith('DRIVER_BUSY:')) {
        const parts = msg.split(':');
        return { success: false, message: `Driver ${parts[1] || ''} is already on a trip. Choose a different driver.` };
      }
      if (msg.startsWith('VEHICLE_UNAVAILABLE:')) {
        return { success: false, message: 'Vehicle is no longer available. Please go back and select another vehicle.' };
      }
      if (msg.startsWith('TRUCK_REQUEST_NOT_HELD:') || msg.startsWith('TRUCK_REQUEST_STATE_CHANGED:')) {
        return { success: false, message: 'Hold expired or was taken by another transporter. Please try again.' };
      }
      if (msg === 'ORDER_NOT_FOUND' || msg.startsWith('TRUCK_REQUEST_NOT_FOUND')) {
        return { success: false, message: 'This order is no longer available.' };
      }

      return { success: false, message: 'Failed to confirm. Please try again.' };
    }
  }

  /**
   * RELEASE HOLD
   * ------------
   * Called when:
   * - Transporter clicks "Reject"
   * - Hold expires (cleanup job)
   * - Transporter closes app
   * 
   * @param holdId - The hold ID to release
   * @param transporterId - The transporter releasing (optional, for validation)
   */
  async releaseHold(
    holdId: string,
    transporterId?: string,
    idempotencyKey?: string,
    releaseSource: 'manual' | 'cleanup' | 'system' = 'manual'
  ): Promise<{ success: boolean; message: string; error?: string }> {
    logger.info(`[TruckHold] Release request: ${holdId}`);

    const normalizedHoldId = (holdId || '').trim();
    const payloadHash = this.buildOperationPayloadHash('release', { holdId: normalizedHoldId });
    if (transporterId && idempotencyKey) {
      const replay = await this.getIdempotentOperationResponse(transporterId, 'release', idempotencyKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) {
          return {
            success: false,
            message: 'Idempotency key reused with a different release payload.',
            error: 'IDEMPOTENCY_CONFLICT'
          };
        }
        return replay.response as { success: boolean; message: string; error?: string };
      }
    }

    let response: { success: boolean; message: string; error?: string } = { success: false, message: 'Failed to release hold', error: 'INTERNAL_ERROR' };
    let statusCode = 400;

    try {
      if (!normalizedHoldId) {
        response = { success: false, message: 'holdId is required', error: 'VALIDATION_ERROR' };
        return response;
      }

      const hold = await prismaClient.truckHoldLedger.findUnique({ where: { holdId: normalizedHoldId } });

      if (!hold) {
        response = { success: false, message: 'Hold not found', error: 'HOLD_NOT_FOUND' };
        return response;
      }

      if (transporterId && hold.transporterId !== transporterId) {
        response = { success: false, message: 'This hold belongs to another transporter', error: 'FORBIDDEN' };
        return response;
      }

      if (hold.status !== 'active') {
        response = { success: true, message: 'Hold already released' };
        statusCode = 200;
        return response;
      }

      const resolvedTransporterId = hold.transporterId;
      await withDbTimeout(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: hold.orderId },
          select: { status: true }
        });

        const orderStatus = (order?.status || '').toString();
        const isActiveOrder = ACTIVE_ORDER_STATUSES.has(orderStatus);
        const nextTruckStatus: TruckRequestStatus = isActiveOrder
          ? TruckRequestStatus.searching
          : orderStatus === 'cancelled'
            ? TruckRequestStatus.cancelled
            : orderStatus === 'expired'
              ? TruckRequestStatus.expired
              : TruckRequestStatus.expired;

        const where: Prisma.TruckRequestWhereInput = {
          id: { in: hold.truckRequestIds },
          orderId: hold.orderId,
          status: TruckRequestStatus.held
        };

        if (FF_HOLD_SAFE_RELEASE_GUARD) {
          where.heldById = resolvedTransporterId;
        }

        await tx.truckRequest.updateMany({
          where,
          data: {
            status: nextTruckStatus,
            heldById: null,
            heldAt: null
          }
        });

        await tx.truckHoldLedger.update({
          where: { holdId: normalizedHoldId },
          data: {
            status: isActiveOrder
              ? 'released'
              : orderStatus === 'cancelled'
                ? 'cancelled'
                : 'expired',
            terminalReason: isActiveOrder ? 'RELEASED_BY_TRANSPORTER' : `ORDER_${orderStatus.toUpperCase() || 'INACTIVE'}`,
            releasedAt: new Date()
          }
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeoutMs: 8000
      });

      // best-effort Redis cleanup for stale lock/index keys
      await holdStore.remove(normalizedHoldId).catch(() => { });

      // 3. Broadcast update
      this.broadcastAvailabilityUpdate(hold.orderId);

      logger.info(`[TruckHold] ✅ Released hold ${normalizedHoldId}. ${hold.quantity} trucks reconciled.`);
      if (releaseSource !== 'cleanup') {
        metrics.incrementCounter('hold.release.total', { source: releaseSource });
      }

      response = { success: true, message: 'Hold released successfully.' };
      statusCode = 200;
      return response;

    } catch (error: any) {
      logger.error(`[TruckHold] Error releasing hold: ${error.message}`, error);
      response = { success: false, message: 'Failed to release hold', error: 'INTERNAL_ERROR' };
      return response;
    } finally {
      if (transporterId && idempotencyKey) {
        await this.saveIdempotentOperationResponse(
          transporterId,
          'release',
          idempotencyKey,
          payloadHash,
          statusCode,
          response
        ).catch(() => { });
      }
    }
  }

  /**
   * GET ORDER AVAILABILITY
   * ----------------------
   * Returns current availability of all truck types for an order.
   * Used by app to show real-time counts.
   * 
   * @param orderId - The order ID
   * @returns OrderAvailability with truck counts
   */
  async getOrderAvailability(orderId: string): Promise<OrderAvailability | null> {
    try {
      const order = await db.getOrderById(orderId);
      if (!order) {
        logger.warn(`[TruckHold] Order not found: ${orderId}`);
        return null;
      }

      const truckRequests = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(orderId) : [];

      // Group by vehicle type
      const truckGroups = new Map<string, {
        requests: any[];
        farePerTruck: number;
      }>();

      for (const tr of truckRequests) {
        const key = `${tr.vehicleType}_${tr.vehicleSubtype || ''}`;
        if (!truckGroups.has(key)) {
          truckGroups.set(key, {
            requests: [],
            farePerTruck: tr.pricePerTruck
          });
        }
        truckGroups.get(key)!.requests.push(tr);
      }

      // Calculate availability for each type
      const trucks: TruckAvailability[] = [];
      let totalValue = 0;

      for (const [key, group] of truckGroups) {
        const [vehicleType, vehicleSubtype] = key.split('_');

        const available = group.requests.filter(r => r.status === 'searching').length;
        const held = group.requests.filter(r => r.status === 'held').length;
        const assigned = group.requests.filter(r => r.status === 'assigned' || r.status === 'completed').length;

        trucks.push({
          vehicleType,
          vehicleSubtype: vehicleSubtype || '',
          totalNeeded: group.requests.length,
          available,
          held,
          assigned,
          farePerTruck: group.farePerTruck
        });

        totalValue += group.requests.length * group.farePerTruck;
      }

      const isFullyAssigned = trucks.every(t => t.available === 0 && t.held === 0);

      return {
        orderId,
        customerName: order.customerName || 'Customer',
        customerPhone: order.customerPhone || '',
        pickup: order.pickup,
        drop: order.drop,
        distanceKm: order.distanceKm || 0,
        goodsType: order.goodsType || 'General',
        trucks,
        totalValue,
        isFullyAssigned
      };

    } catch (error: any) {
      logger.error(`[TruckHold] Error getting availability: ${error.message}`, error);
      return null;
    }
  }

  async getMyActiveHold(
    transporterId: string,
    orderId: string,
    vehicleType: string,
    vehicleSubtype: string
  ): Promise<{
    holdId: string;
    orderId: string;
    vehicleType: string;
    vehicleSubtype: string;
    quantity: number;
    expiresAt: string;
    status: string;
  } | null> {
    const hold = await this.findActiveLedgerHold(
      transporterId,
      orderId,
      this.normalizeVehiclePart(vehicleType),
      this.normalizeVehiclePart(vehicleSubtype)
    );
    if (!hold) return null;
    return {
      holdId: hold.holdId,
      orderId: hold.orderId,
      vehicleType: hold.vehicleType,
      vehicleSubtype: hold.vehicleSubtype,
      quantity: hold.quantity,
      expiresAt: hold.expiresAt.toISOString(),
      status: hold.status
    };
  }

  async closeActiveHoldsForOrder(
    orderId: string,
    terminalReason: 'ORDER_CANCELLED' | 'ORDER_EXPIRED'
  ): Promise<number> {
    const activeHolds = await prismaClient.truckHoldLedger.findMany({
      where: {
        orderId,
        status: 'active'
      },
      select: {
        holdId: true,
        transporterId: true,
        truckRequestIds: true
      }
    });

    if (activeHolds.length === 0) return 0;

    const terminalTruckStatus: TruckRequestStatus = terminalReason === 'ORDER_CANCELLED'
      ? TruckRequestStatus.cancelled
      : TruckRequestStatus.expired;
    for (const hold of activeHolds) {
      await withDbTimeout(async (tx) => {
        await tx.truckRequest.updateMany({
          where: {
            id: { in: hold.truckRequestIds },
            orderId,
            status: TruckRequestStatus.held,
            heldById: hold.transporterId
          },
          data: {
            status: terminalTruckStatus,
            heldById: null,
            heldAt: null
          }
        });

        await tx.truckHoldLedger.update({
          where: { holdId: hold.holdId },
          data: {
            status: terminalReason === 'ORDER_CANCELLED' ? 'cancelled' : 'expired',
            terminalReason,
            releasedAt: new Date()
          }
        });
      }).catch((error) => {
        logger.warn(`[TruckHold] Failed to close hold ${hold.holdId} for order ${orderId}: ${String((error as Error)?.message || error)}`);
      });

      await holdStore.remove(hold.holdId).catch(() => { });
    }

    return activeHolds.length;
  }

  async clearHoldCacheEntries(holdIds: string[]): Promise<void> {
    if (!Array.isArray(holdIds) || holdIds.length === 0) return;
    for (const holdId of holdIds) {
      if (!holdId) continue;
      await holdStore.remove(holdId).catch(() => { });
    }
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Get available (not held, not assigned) truck requests for a vehicle type
   */
  private async getAvailableTruckRequests(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<any[]> {
    const allRequests = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(orderId) : [];

    return allRequests.filter(tr =>
      tr.vehicleType.toLowerCase() === vehicleType.toLowerCase() &&
      (tr.vehicleSubtype || '').toLowerCase() === vehicleSubtype.toLowerCase() &&
      tr.status === 'searching'
    );
  }

  /**
   * Broadcast availability update via WebSocket
   * 
   * =========================================================================
   * PERSONALIZED REAL-TIME UPDATES
   * =========================================================================
   * 
   * When trucks are accepted/held/released, we need to:
   * 1. Update ALL transporters viewing this order
   * 2. Each gets their PERSONALIZED trucksYouCanProvide
   * 3. If order is fully filled, close broadcast for everyone
   * 
   * Example:
   *   Order needs 5 trucks, Transporter A accepts 2
   *   → Now needs 3 trucks
   *   → Transporter B (has 4 available) now sees "3 trucks" (was 4)
   *   → Transporter C (has 2 available) still sees "2 trucks" (unchanged)
   * =========================================================================
   */
  private broadcastAvailabilityUpdate(orderId: string): void {
    this.getOrderAvailability(orderId).then(async availability => {
      if (!availability) return;

      const order = await db.getOrderById(orderId);
      if (!order) return;

      logger.info(`╔══════════════════════════════════════════════════════════════╗`);
      logger.info(`║  📡 BROADCASTING AVAILABILITY UPDATE                         ║`);
      logger.info(`╠══════════════════════════════════════════════════════════════╣`);
      logger.info(`║  Order: ${orderId.substring(0, 8)}...`);
      logger.info(`║  Filled: ${order.trucksFilled}/${order.totalTrucks}`);
      logger.info(`║  Fully Assigned: ${availability.isFullyAssigned}`);
      logger.info(`╚══════════════════════════════════════════════════════════════╝`);

      // If fully assigned, broadcast closure to everyone
      if (availability.isFullyAssigned) {
        socketService.broadcastToAll('broadcast_closed', {
          orderId,
          reason: 'fully_assigned',
          message: 'All trucks have been assigned',
          timestamp: new Date().toISOString()
        });
        logger.info(`   📢 Broadcast closed - all trucks assigned`);
        return;
      }

      // Send personalized updates to each transporter
      // Get all transporters who were notified about this order
      const truckRequests = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(orderId) : [];
      const notifiedTransporterIds = new Set<string>();
      const queuedBroadcasts: Array<Promise<unknown>> = [];

      for (const tr of truckRequests) {
        if (tr.notifiedTransporters) {
          tr.notifiedTransporters.forEach((id: string) => notifiedTransporterIds.add(id));
        }
      }

      // For each vehicle type in the order, calculate personalized updates
      for (const truckType of availability.trucks) {
        const { vehicleType, vehicleSubtype, available: trucksStillSearching } = truckType;

        // Skip if no trucks searching for this type
        if (trucksStillSearching <= 0) continue;

        // Get availability snapshot for all transporters with this vehicle type
        // CRITICAL FIX: Must await — db is Prisma instance, this is async!
        const transporterSnapshot = await db.getTransportersAvailabilitySnapshot(vehicleType, vehicleSubtype) as Array<{
          transporterId: string;
          transporterName: string;
          totalOwned: number;
          available: number;
          inTransit: number;
        }>;

        // Create map for quick lookup
        const availabilityMap = new Map(
          transporterSnapshot.map(t => [t.transporterId, t])
        );

        // Send personalized update to each notified transporter
        for (const transporterId of notifiedTransporterIds) {
          const transporterAvailability = availabilityMap.get(transporterId);

          // Skip if this transporter doesn't have this vehicle type
          if (!transporterAvailability) continue;

          // Calculate personalized capacity
          const trucksYouCanProvide = Math.min(
            transporterAvailability.available,
            trucksStillSearching
          );

          // Skip if transporter has no available trucks
          if (trucksYouCanProvide <= 0) {
            // Notify them that they can't participate anymore
            queuedBroadcasts.push(queueService.queueBroadcast(transporterId, 'broadcast_update', {
              type: 'no_available_trucks',
              orderId,
              vehicleType,
              vehicleSubtype,
              trucksStillNeeded: trucksStillSearching,
              trucksYouCanProvide: 0,
              yourAvailableTrucks: transporterAvailability.available,
              message: 'You have no available trucks for this order',
              timestamp: new Date().toISOString()
            }).catch((error) => {
              logger.warn(`[TruckHold] Failed to queue no_available_trucks update for transporter ${transporterId}: ${String((error as Error)?.message || error)}`);
            }));
            continue;
          }

          // Send personalized update
          queuedBroadcasts.push(queueService.queueBroadcast(transporterId, 'broadcast_update', {
            type: 'availability_changed',
            orderId,
            vehicleType,
            vehicleSubtype,

            // Order progress
            totalTrucksNeeded: order.totalTrucks,
            trucksFilled: order.trucksFilled,
            trucksStillNeeded: trucksStillSearching,

            // Personalized for this transporter
            trucksYouCanProvide,
            maxTrucksYouCanProvide: trucksYouCanProvide,
            yourAvailableTrucks: transporterAvailability.available,
            yourTotalTrucks: transporterAvailability.totalOwned,

            // Full availability info
            trucks: availability.trucks,
            isFullyAssigned: availability.isFullyAssigned,

            timestamp: new Date().toISOString()
          }).catch((error) => {
            logger.warn(`[TruckHold] Failed to queue availability update for transporter ${transporterId}: ${String((error as Error)?.message || error)}`);
          }));

          logger.debug(`   📱 → ${transporterId.substring(0, 8)}: can provide ${trucksYouCanProvide}/${trucksStillSearching}`);
        }
      }

      if (queuedBroadcasts.length > 0) {
        await Promise.allSettled(queuedBroadcasts);
      }

      // Also broadcast general update for any listeners (e.g., admin dashboard)
      socketService.broadcastToAll('trucks_availability_updated', {
        orderId,
        trucks: availability.trucks,
        isFullyAssigned: availability.isFullyAssigned,
        totalTrucksFilled: order.trucksFilled,
        totalTrucksNeeded: order.totalTrucks,
        timestamp: new Date().toISOString()
      });

      logger.info(`   ✅ Personalized updates sent to ${notifiedTransporterIds.size} transporters`);
    });
  }

  /**
   * Cleanup job - releases expired holds
   * Note: With Redis TTL, locks auto-expire. This is kept for any edge cases
   * and to clean up database state for trucks that were held but lock expired.
   */
  private startCleanupJob(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const now = new Date();
        let cleanupReleasedCount = 0;
        const expiredHolds = await prismaClient.truckHoldLedger.findMany({
          where: {
            status: 'active',
            expiresAt: { lte: now }
          },
          take: 200,
          orderBy: { expiresAt: 'asc' },
          select: { holdId: true, orderId: true }
        });

        for (const hold of expiredHolds) {
          logger.info(`[TruckHold] Auto-releasing expired hold: ${hold.holdId}`);
          const releaseResult = await this.releaseHold(hold.holdId, undefined, undefined, 'cleanup');
          if (releaseResult.success) {
            cleanupReleasedCount++;
          }
          await prismaClient.truckHoldLedger.update({
            where: { holdId: hold.holdId },
            data: {
              status: 'expired',
              terminalReason: 'HOLD_TTL_EXPIRED',
              releasedAt: new Date()
            }
          }).catch(() => { });
        }

        if (expiredHolds.length > 0) {
          logger.info(`[TruckHold] Cleanup: Reconciled ${expiredHolds.length} expired holds`);
          // Emit explicit cleanup metric at job level for release-gate visibility.
          metrics.incrementCounter('hold.cleanup.released_total', { source: 'cleanup_job' }, cleanupReleasedCount);
        }

        const nowMs = Date.now();
        if (nowMs - this.lastIdempotencyPurgeAtMs >= HOLD_IDEMPOTENCY_PURGE_INTERVAL_MS) {
          this.lastIdempotencyPurgeAtMs = nowMs;
          const cutoff = new Date(nowMs - (HOLD_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000));
          const purged = await prismaClient.truckHoldIdempotency.deleteMany({
            where: {
              createdAt: { lt: cutoff }
            }
          });
          if (purged.count > 0) {
            logger.info(`[TruckHold] Purged ${purged.count} old hold idempotency row(s)`);
            metrics.incrementCounter('hold.idempotency.purged_total', {}, purged.count);
          }
        }
      } catch (error: any) {
        logger.error(`[TruckHold] Cleanup job error: ${error.message}`);
      }
    }, CONFIG.CLEANUP_INTERVAL_MS);

    logger.info(`[TruckHold] Cleanup job started (every ${CONFIG.CLEANUP_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop cleanup job (for graceful shutdown)
   */
  stopCleanupJob(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('[TruckHold] Cleanup job stopped');
    }
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const truckHoldService = new TruckHoldService();
