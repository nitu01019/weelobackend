/**
 * =============================================================================
 * REDIS CLUSTER-SAFE SCAN — F-B-08
 * =============================================================================
 *
 * Problem:
 *   In Redis Cluster mode, `redis.scan(cursor)` on the top-level cluster client
 *   only walks the keyspace of ONE node (the one the client is currently routed
 *   to). Callers that rely on this to enumerate keys (`redisService.keys('*')`,
 *   `scanIterator('*')`) silently miss keys on every other master node.
 *
 *   The fix is to iterate each master via `cluster.nodes('master')` and run an
 *   independent SCAN per node, yielding the union. In single-node mode, we fall
 *   through to the transport's existing `scanIterator` behavior.
 *
 * Gating:
 *   `FF_CLUSTER_SCAN_FANOUT` — default ON. If flipped off, behavior collapses
 *   back to the legacy single-node scan (for safety rollback).
 *
 * Unblocks follow-ups (F-B-01/04/07/12) that depend on exhaustive key walking
 * in cluster mode.
 * =============================================================================
 */

import { redisService } from './redis.service';
import { FLAGS, isEnabled } from '../config/feature-flags';
import { logger } from './logger.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IoRedisNode = any;

/**
 * Async generator yielding batches of keys matching `pattern`.
 *
 * In Redis Cluster mode: fans out SCAN across all master nodes and yields each
 * node's batches. In single-node mode: delegates to redisService.scanIterator.
 *
 * Usage:
 *   for await (const batch of clusterScanAll('fleet:*')) {
 *     for (const key of batch) {
 *       // process each key
 *     }
 *   }
 */
export async function* clusterScanAll(
  pattern: string,
  count = 100
): AsyncGenerator<string[], void, void> {
  const fanoutEnabled = isEnabled(FLAGS.CLUSTER_SCAN_FANOUT);

  if (!fanoutEnabled) {
    yield* collectSingleNode(pattern, count);
    return;
  }

  const rawClient: IoRedisNode | null = redisService.getClient?.() ?? null;

  // Cluster detection: ioredis cluster instances expose `.nodes('master')`.
  // Fall back to single-node path for:
  //   - in-memory fallback client
  //   - single-node ioredis client
  //   - no client at all (degraded startup)
  const isCluster =
    rawClient &&
    typeof rawClient.nodes === 'function' &&
    // Cluster instances expose `slots` or `connectionPool`. Be defensive —
    // ignore stubs that happen to expose `.nodes` without a master list.
    (rawClient.slots !== undefined || rawClient.connectionPool !== undefined);

  if (!isCluster) {
    yield* collectSingleNode(pattern, count);
    return;
  }

  let masters: IoRedisNode[] = [];
  try {
    masters = rawClient.nodes('master') || [];
  } catch (err: unknown) {
    logger.warn(
      `[ClusterScan] cluster.nodes('master') threw: ${(err as Error).message}; falling back to single-node scan`
    );
    yield* collectSingleNode(pattern, count);
    return;
  }

  if (masters.length === 0) {
    // Cluster with no discovered masters — degenerate case.
    yield* collectSingleNode(pattern, count);
    return;
  }

  for (const node of masters) {
    try {
      yield* scanNode(node, pattern, count);
    } catch (err: unknown) {
      logger.warn(
        `[ClusterScan] node SCAN failed (pattern=${pattern}): ${(err as Error).message}; continuing with remaining nodes`
      );
    }
  }
}

/**
 * Flattened convenience: collects every matching key in one array.
 * Prefer the generator form for large keyspaces to avoid buffering.
 */
export async function clusterScanAllFlat(
  pattern: string,
  count = 100
): Promise<string[]> {
  const out: string[] = [];
  for await (const batch of clusterScanAll(pattern, count)) {
    for (const key of batch) out.push(key);
  }
  return out;
}

async function* scanNode(
  node: IoRedisNode,
  pattern: string,
  count: number
): AsyncGenerator<string[], void, void> {
  let cursor = '0';
  do {
    const result = await node.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = result[0];
    const keys: string[] = result[1] ?? [];
    if (keys.length > 0) {
      yield keys;
    }
  } while (cursor !== '0');
}

async function* collectSingleNode(
  pattern: string,
  count: number
): AsyncGenerator<string[], void, void> {
  let batch: string[] = [];
  for await (const key of redisService.scanIterator(pattern, count)) {
    batch.push(key);
    if (batch.length >= count) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
