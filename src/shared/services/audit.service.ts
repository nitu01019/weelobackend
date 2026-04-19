import { prismaClient } from '../database/prisma.service';
import { logger } from './logger.service';

const FF_ASYNC_AUDIT = process.env.FF_ASYNC_AUDIT === 'true';

interface StatusEventParams {
  entityType: 'order' | 'booking' | 'assignment' | 'vehicle';
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  triggeredBy?: string;
  triggerReason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Perform inline (synchronous) DB write for a status event.
 */
async function inlineWrite(
  params: StatusEventParams,
  client: any
): Promise<void> {
  await client.statusEvent.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      triggeredBy: params.triggeredBy ?? 'system',
      triggerReason: params.triggerReason,
      metadata: params.metadata ?? undefined,
    },
  });
}

/**
 * Record a status transition event.
 *
 * When FF_ASYNC_AUDIT=true and no transaction is passed, the event is
 * queued via the AUDIT queue for batched insertion (fire-and-forget).
 * If queuing fails, it falls back to an inline write.
 *
 * When a transaction (`tx`) is supplied, the write is always inline
 * to preserve transactional consistency.
 */
export async function recordStatusChange(
  params: StatusEventParams,
  tx?: any
): Promise<void> {
  // Transactional path — always inline
  if (tx) {
    try {
      await inlineWrite(params, tx);
    } catch (err: unknown) {
      logger.warn('[audit] Failed to record status event (tx)', {
        entityType: params.entityType,
        entityId: params.entityId,
        toStatus: params.toStatus,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Async path — fire-and-forget via AUDIT queue
  if (FF_ASYNC_AUDIT) {
    try {
      // Lazy import to avoid circular dependency at module load time
      const { queueService } = require('./queue.service');
      queueService
        .add('audit', 'audit_event', params)
        .catch((queueErr: unknown) => {
          logger.warn('[audit] Queue failed, falling back to inline write', {
            error: queueErr instanceof Error ? queueErr.message : String(queueErr),
          });
          inlineWrite(params, prismaClient).catch((dbErr: unknown) => {
            logger.warn('[audit] Inline fallback also failed', {
              entityType: params.entityType,
              entityId: params.entityId,
              error: dbErr instanceof Error ? dbErr.message : String(dbErr),
            });
          });
        });
    } catch (err: unknown) {
      // Synchronous failure (e.g. require() issue) — inline fallback
      logger.warn('[audit] Async audit setup failed, inline fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await inlineWrite(params, prismaClient);
      } catch (dbErr: unknown) {
        logger.warn('[audit] Failed to record status event', {
          entityType: params.entityType,
          entityId: params.entityId,
          toStatus: params.toStatus,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
    }
    return;
  }

  // Default path — inline write (backwards compatible)
  try {
    await inlineWrite(params, prismaClient);
  } catch (err: unknown) {
    logger.warn('[audit] Failed to record status event', {
      entityType: params.entityType,
      entityId: params.entityId,
      toStatus: params.toStatus,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
