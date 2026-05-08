/**
 * =============================================================================
 * BROADCAST DECLINE TABLE ASSERTION (P0-4 / V3-M06)
 * =============================================================================
 *
 * `BroadcastDecline` is the durable backing store for transporter decline
 * events emitted from broadcast.service.ts. Redis holds the hot path; the
 * table is a "fire-and-forget" persistence layer used by analytics and
 * post-mortem queries.
 *
 * The table is provisioned via a direct SQL migration (see
 * prisma/manual-migrations/) — it is NOT in schema.prisma. If the table is
 * missing in a given environment, every decline triggers a logger.warn at
 * runtime and analytics quietly diverges from the source-of-truth Redis set.
 *
 * This boot-time assertion makes that divergence visible at startup instead
 * of letting it silently rot. V3-M06 in the validated index classifies this
 * as LOW severity — the assertion is **WARN, NOT HALT**. Production must
 * never refuse traffic over a missing analytics-side table.
 *
 * Wired into bootstrap() in src/server.ts after the FCM readiness assertion
 * and before server.listen.
 * =============================================================================
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger.service';
import { metrics } from './metrics.service';

const TABLE_NAME = 'BroadcastDecline';

interface ExistsRow {
  exists: boolean;
}

/**
 * Verify that the BroadcastDecline table is present in the connected
 * database. Logs a warn (and increments a counter) when missing; never
 * throws or halts boot.
 *
 * @returns true when the table exists, false otherwise. Callers may use
 *   the return value for additional diagnostic logging — the assertion
 *   itself never propagates errors.
 */
export async function assertBroadcastDeclineTableExists(
  prisma: PrismaClient
): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<ExistsRow[]>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = $1
       ) AS "exists"`,
      TABLE_NAME
    );

    const present = Array.isArray(rows) && rows[0]?.exists === true;

    if (present) {
      logger.info(`[V3-M06] BroadcastDecline table present — durable persistence active`);
      metrics.incrementCounter('broadcast_decline_table_assertion_total', { result: 'present' });
      return true;
    }

    logger.warn(
      `[V3-M06] BroadcastDecline table is MISSING. Decline events will be ` +
      `recorded in Redis only (24h TTL); analytics + post-mortem queries ` +
      `will diverge until the manual migration in prisma/manual-migrations/ ` +
      `is applied. This is non-fatal by design (V3-M06 LOW).`
    );
    metrics.incrementCounter('broadcast_decline_table_assertion_total', { result: 'missing' });
    return false;
  } catch (err) {
    // Open-fail: never halt boot on a diagnostic check.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[V3-M06] BroadcastDecline table assertion threw — continuing boot (non-fatal).`,
      { error: message }
    );
    metrics.incrementCounter('broadcast_decline_table_assertion_total', { result: 'error' });
    return false;
  }
}
