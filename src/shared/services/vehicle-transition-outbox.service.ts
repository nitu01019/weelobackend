/**
 * =============================================================================
 * VEHICLE TRANSITION OUTBOX SERVICE (F-A-64)
 * =============================================================================
 *
 * Durable outbox poller for Vehicle.status transitions.
 *
 * Background:
 *   order-accept.service.ts:486-500 used to do a post-TX dual-write:
 *     1. UPDATE "Vehicle" SET status='on_hold' ...       — in TX, committed
 *     2. await onVehicleTransition(...)                  — Redis, post-TX
 *   If step 2 failed (Redis blip, AZ partition, GC pause) the catch block
 *   only logged a warning. Net result: DB says on_hold, live-availability
 *   still shows the vehicle as available → double-booking window.
 *
 * Fix:
 *   - Inside the TX, INSERT a VehicleTransitionOutbox row alongside the
 *     Vehicle.status update. The INSERT and UPDATE share one commit boundary.
 *   - A background poller (this file), leader-elected via F-A-56 helper,
 *     claims rows with SELECT ... FOR UPDATE SKIP LOCKED in batches of 50,
 *     replays onVehicleTransition(), exp-backoff retries failures, and
 *     parks rows into DLQ after 5 attempts.
 *
 * Feature flag: FF_VEHICLE_TRANSITION_OUTBOX (release, default OFF).
 *   The in-TX write is flag-gated in order-accept; the poller is always safe
 *   to run because it no-ops when there are no unprocessed rows.
 * =============================================================================
 */

import { Prisma } from '@prisma/client';
import { prismaClient } from '../database/prisma.service';
import { logger } from './logger.service';
import { metrics } from '../monitoring/metrics.service';
import {
  acquireLeader,
  renewLeader,
  startHeartbeat,
} from './leader-election.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VEHICLE_TRANSITION_OUTBOX_LEADER_KEY = 'vehicle-transition-outbox:leader';
export const VEHICLE_TRANSITION_OUTBOX_LEADER_TTL_SEC = 60;
export const VEHICLE_TRANSITION_OUTBOX_POLL_INTERVAL_MS = 10_000;
export const VEHICLE_TRANSITION_OUTBOX_BATCH_SIZE = 50;
export const VEHICLE_TRANSITION_OUTBOX_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VehicleTransitionOutboxRow {
  id: string;
  vehicleId: string;
  vehicleKey: string | null;
  transporterId: string;
  fromStatus: string;
  toStatus: string;
  reason: string | null;
  createdAt: Date;
  processedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Instance identity (per-process) for leader election
// ---------------------------------------------------------------------------

function buildInstanceId(): string {
  const host = process.env.HOSTNAME || process.env.ECS_TASK_ID || 'local';
  return `${host}:${process.pid}:${Date.now()}`;
}

const INSTANCE_ID = buildInstanceId();

// Internal module state — cleared by reset helpers in tests.
let heartbeatTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let isLeader = false;

// ---------------------------------------------------------------------------
// Exp-backoff retry delay (used only as a logical delay between poll ticks;
// claim still happens in each tick — the attempts counter bounds DLQ).
// ---------------------------------------------------------------------------

export function calculateOutboxBackoffMs(attempts: number): number {
  const capped = Math.max(1, attempts);
  const base = Math.min(30_000, Math.pow(2, capped) * 1000);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

// ---------------------------------------------------------------------------
// Lazy import of onVehicleTransition to avoid require-time cycle:
// vehicle-lifecycle.service already imports liveAvailability which in turn
// may import services that pull in metrics/logger — this indirection keeps
// the outbox poller's import graph clean.
// ---------------------------------------------------------------------------

type OnVehicleTransitionFn = (
  transporterId: string,
  vehicleId: string,
  vehicleKey: string | null | undefined,
  oldStatus: string,
  newStatus: string,
  context: string
) => Promise<void>;

async function loadOnVehicleTransition(): Promise<OnVehicleTransitionFn> {
  // require (not import) so vitest/jest mocking via jest.mock still works on
  // the caller side without a hoisting dance.
  const mod = require('./vehicle-lifecycle.service') as {
    onVehicleTransition: OnVehicleTransitionFn;
  };
  return mod.onVehicleTransition;
}

// ---------------------------------------------------------------------------
// Claim + process a single batch (public for tests)
// ---------------------------------------------------------------------------

/**
 * Claim up to `limit` unprocessed rows with FOR UPDATE SKIP LOCKED, replay
 * each via onVehicleTransition, and record the outcome.
 *
 * Returns the number of rows processed (including DLQ-moves) — 0 when the
 * outbox is empty.
 */
export async function processVehicleTransitionOutboxBatch(
  limit: number = VEHICLE_TRANSITION_OUTBOX_BATCH_SIZE
): Promise<number> {
  const onVehicleTransition = await loadOnVehicleTransition();

  // One transaction wraps the SELECT FOR UPDATE SKIP LOCKED + the row-level
  // updates. Postgres releases the locks on commit so sibling pollers see the
  // updated rows cleanly.
  return prismaClient.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<VehicleTransitionOutboxRow[]>`
      SELECT id, "vehicleId", "vehicleKey", "transporterId",
             "fromStatus", "toStatus", "reason", "createdAt",
             "processedAt", "attempts", "lastError"
      FROM "VehicleTransitionOutbox"
      WHERE "processedAt" IS NULL
        AND "attempts" < ${VEHICLE_TRANSITION_OUTBOX_MAX_ATTEMPTS}
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    if (rows.length === 0) return 0;

    let processed = 0;
    for (const row of rows) {
      const nextAttempts = row.attempts + 1;
      try {
        await onVehicleTransition(
          row.transporterId,
          row.vehicleId,
          row.vehicleKey,
          row.fromStatus,
          row.toStatus,
          row.reason || 'outboxReplay'
        );

        await tx.$executeRaw`
          UPDATE "VehicleTransitionOutbox"
          SET "processedAt" = now(),
              "attempts" = ${nextAttempts},
              "lastError" = NULL
          WHERE id = ${row.id}::uuid
        `;
        metrics.incrementCounter('vehicle_transition_outbox_processed_total', {
          result: 'success',
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isDlq = nextAttempts >= VEHICLE_TRANSITION_OUTBOX_MAX_ATTEMPTS;

        await tx.$executeRaw`
          UPDATE "VehicleTransitionOutbox"
          SET "attempts" = ${nextAttempts},
              "lastError" = ${message}
          WHERE id = ${row.id}::uuid
        `;

        if (isDlq) {
          metrics.incrementCounter('vehicle_transition_outbox_dlq_total');
          logger.error('[VehicleTransitionOutbox] Row exceeded max attempts — DLQ', {
            id: row.id,
            vehicleId: row.vehicleId.substring(0, 8),
            attempts: nextAttempts,
            error: message,
          });
        } else {
          metrics.incrementCounter('vehicle_transition_outbox_processed_total', {
            result: 'failure',
          });
          logger.warn('[VehicleTransitionOutbox] Retry will be attempted next poll', {
            id: row.id,
            vehicleId: row.vehicleId.substring(0, 8),
            attempts: nextAttempts,
            error: message,
          });
        }
      }
      processed += 1;
    }

    return processed;
  }, { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Pending gauge refresh — one cheap count(*) query used by monitoring
// ---------------------------------------------------------------------------

export async function refreshPendingGauge(): Promise<number> {
  try {
    const rows = await prismaClient.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "VehicleTransitionOutbox"
      WHERE "processedAt" IS NULL
    `;
    const count = rows[0] ? Number(rows[0].count) : 0;
    metrics.setGauge('vehicle_transition_outbox_pending_gauge', count);
    return count;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[VehicleTransitionOutbox] pending gauge refresh failed', {
      error: message,
    });
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Leader-elected poll tick
// ---------------------------------------------------------------------------

/**
 * Run one poll cycle. Returns the processed row count (0 when not leader or
 * outbox empty). Safe to call from setInterval.
 */
export async function runVehicleTransitionOutboxPoll(): Promise<number> {
  // Fresh acquire OR atomic renew — either makes us leader safely (F-A-56).
  if (!isLeader) {
    const acquired = await acquireLeader(
      VEHICLE_TRANSITION_OUTBOX_LEADER_KEY,
      INSTANCE_ID,
      VEHICLE_TRANSITION_OUTBOX_LEADER_TTL_SEC
    );
    if (!acquired) return 0;
    isLeader = true;
    if (!heartbeatTimer) {
      heartbeatTimer = startHeartbeat(
        VEHICLE_TRANSITION_OUTBOX_LEADER_KEY,
        INSTANCE_ID,
        VEHICLE_TRANSITION_OUTBOX_LEADER_TTL_SEC,
        Math.max(5_000, Math.floor((VEHICLE_TRANSITION_OUTBOX_LEADER_TTL_SEC * 1000) / 3))
      );
    }
  } else {
    // Proactively renew inside the poll tick — if renewal fails we lost the
    // lease and must stop polling until reacquisition.
    const renewed = await renewLeader(
      VEHICLE_TRANSITION_OUTBOX_LEADER_KEY,
      INSTANCE_ID,
      VEHICLE_TRANSITION_OUTBOX_LEADER_TTL_SEC
    );
    if (!renewed) {
      isLeader = false;
      return 0;
    }
  }

  try {
    const processed = await processVehicleTransitionOutboxBatch();
    await refreshPendingGauge();
    return processed;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[VehicleTransitionOutbox] Poll cycle failed', { error: message });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: wire the interval from server.ts
// ---------------------------------------------------------------------------

/**
 * Start the periodic poller. Idempotent — repeated calls return the same
 * timer so tests can call it without bootstrapping two intervals.
 */
export function startVehicleTransitionOutboxPoller(
  intervalMs: number = VEHICLE_TRANSITION_OUTBOX_POLL_INTERVAL_MS
): NodeJS.Timeout {
  if (pollTimer) return pollTimer;

  pollTimer = setInterval(() => {
    runVehicleTransitionOutboxPoll().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[VehicleTransitionOutbox] Interval tick failed', { error: message });
    });
  }, intervalMs);

  if (typeof (pollTimer as unknown as { unref?: () => void }).unref === 'function') {
    (pollTimer as unknown as { unref: () => void }).unref();
  }

  logger.info('[VehicleTransitionOutbox] Poller started', {
    intervalMs,
    batchSize: VEHICLE_TRANSITION_OUTBOX_BATCH_SIZE,
    maxAttempts: VEHICLE_TRANSITION_OUTBOX_MAX_ATTEMPTS,
  });

  return pollTimer;
}

/**
 * Stop the poller (used by tests and graceful shutdown).
 */
export function stopVehicleTransitionOutboxPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  isLeader = false;
}

/**
 * Reset internal module state — test hook only. Production code must not
 * reach for this.
 */
export function __resetVehicleTransitionOutboxForTests(): void {
  stopVehicleTransitionOutboxPoller();
}
