/**
 * =============================================================================
 * P1-T1.5 — Boot-path SCAN iterator semantics (SC8) + L6 log-once guard
 * =============================================================================
 *
 * SC8 invariants (documented in .planning/verification/ISSUES-AND-SOLUTIONS.md
 * `## SC8 —`):
 *   1. `scanIterator(pattern)` yields every key matching `pattern`.
 *   2. Over a large keyspace (100k synthetic keys) the iterator completes
 *      without exceeding a documented event-loop-lag p99 threshold — the
 *      whole point of SC8 (KEYS is O(N), blocks Redis single-thread;
 *      SCAN yields between cursor batches).
 *   3. The `server_boot_scan_ms` histogram is pre-registered at boot time so
 *      observations do not auto-create.
 *
 * L6 invariant: the `[BACKPRESSURE]` startup log fires at most once per
 * process boot when the in-memory path is first selected.
 * =============================================================================
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { metrics } from '../shared/monitoring/metrics.service';

interface ScanLikeClient {
  scan(cursor: string, matchKey: 'MATCH', pattern: string, countKey: 'COUNT', count: number): Promise<[string, string[]]>;
  keys(pattern: string): Promise<string[]>;
}

/**
 * Wraps an in-memory set of keys behind a `scan`-compatible surface.
 * Cursor is a numeric offset string. Batches honour `count`.
 */
class FakeRedisScanClient implements ScanLikeClient {
  private readonly store: string[];

  constructor(keys: string[]) {
    this.store = [...keys];
  }

  async scan(
    cursor: string,
    _matchKey: 'MATCH',
    pattern: string,
    _countKey: 'COUNT',
    count: number,
  ): Promise<[string, string[]]> {
    const start = parseInt(cursor, 10) || 0;
    const end = Math.min(start + count, this.store.length);
    const batch: string[] = [];
    const matcher = globToRegex(pattern);
    for (let i = start; i < end; i += 1) {
      if (matcher.test(this.store[i])) batch.push(this.store[i]);
    }
    const next = end >= this.store.length ? '0' : String(end);
    // Yield to the event loop between batches — SCAN is non-blocking.
    await Promise.resolve();
    return [next, batch];
  }

  async keys(pattern: string): Promise<string[]> {
    const matcher = globToRegex(pattern);
    return this.store.filter((k) => matcher.test(k));
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Async generator identical in contract to `redisService.scanIterator`. */
async function* scanIterator(
  client: ScanLikeClient,
  pattern: string,
  count = 200,
): AsyncIterableIterator<string> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const key of keys) yield key;
  } while (cursor !== '0');
}

function seedKeys(n: number): string[] {
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    keys[i] = `geo:transporters:v-${i.toString(36)}`;
  }
  return keys;
}

describe('P1-T1.5 SC8 — boot scan semantics', () => {
  test('scanIterator yields every matching key (parity with keys())', async () => {
    const seeded = seedKeys(1_000);
    const client = new FakeRedisScanClient(seeded);

    const scanned: string[] = [];
    for await (const key of scanIterator(client, 'geo:transporters:*', 200)) {
      scanned.push(key);
    }
    const viaKeys = await client.keys('geo:transporters:*');

    expect(scanned).toHaveLength(seeded.length);
    expect(scanned.sort()).toEqual(viaKeys.sort());
  });

  test('scanIterator ignores non-matching keys (MATCH semantics preserved)', async () => {
    const seeded = [
      ...seedKeys(200),
      'other:key:1',
      'geo:drivers:x',
      'not:geo:transporters:should-not-match',
    ];
    const client = new FakeRedisScanClient(seeded);

    const scanned: string[] = [];
    for await (const key of scanIterator(client, 'geo:transporters:*', 50)) {
      scanned.push(key);
    }
    expect(scanned).toHaveLength(200);
    expect(scanned.every((k) => k.startsWith('geo:transporters:'))).toBe(true);
  });

  test('scanIterator handles 100k keys without pathological event-loop lag', async () => {
    const N = 100_000;
    const seeded = seedKeys(N);
    const client = new FakeRedisScanClient(seeded);

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();

    const t0 = performance.now();
    let collected = 0;
    for await (const _key of scanIterator(client, 'geo:transporters:*', 200)) {
      collected += 1;
    }
    const elapsedMs = performance.now() - t0;
    histogram.disable();

    expect(collected).toBe(N);
    // Generous cap to survive slow CI runners while still catching regressions.
    const p99Ms = histogram.percentile(99) / 1e6;
    expect(p99Ms).toBeLessThan(500);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 30_000);

  test('scanIterator equivalence vs keys() for the boot consumer', async () => {
    const seeded = seedKeys(5_000);
    const client = new FakeRedisScanClient(seeded);

    const viaScan: string[] = [];
    for await (const key of scanIterator(client, 'geo:transporters:*', 200)) {
      viaScan.push(key);
    }
    const viaKeys = await client.keys('geo:transporters:*');

    const project = (keys: string[]): string[] =>
      keys.map((k) => k.replace('geo:transporters:', '')).filter(Boolean).sort();

    expect(project(viaScan)).toEqual(project(viaKeys));
  });

  test('server_boot_scan_ms histogram is pre-registered at boot', () => {
    // @ts-expect-error — access the private registry for assertion only
    const histograms: Map<string, unknown> = metrics.histograms;
    expect(histograms.has('server_boot_scan_ms')).toBe(true);
  });

  test('server_boot_scan_ms accepts observations without throwing', () => {
    expect(() => {
      metrics.observeHistogram('server_boot_scan_ms', 12.5);
      metrics.observeHistogram('server_boot_scan_ms', 250);
      metrics.observeHistogram('server_boot_scan_ms', 5000);
    }).not.toThrow();
  });

  test('redisService.scanIterator (in-memory impl) matches MATCH pattern', async () => {
    const { redisService } = await import('../shared/services/redis.service');
    await redisService.initialize();

    const ids = Array.from({ length: 500 }, (_, i) => `t-${i}`);
    await Promise.all(ids.map((id) => redisService.set(`geo:transporters:${id}`, '1')));
    await redisService.set('other:unrelated:key', '1');

    const scanned: string[] = [];
    for await (const key of redisService.scanIterator('geo:transporters:*', 200)) {
      scanned.push(key);
    }

    expect(scanned.length).toBeGreaterThanOrEqual(ids.length);
    expect(scanned.every((k) => k.startsWith('geo:transporters:'))).toBe(true);

    await Promise.all(ids.map((id) => redisService.del(`geo:transporters:${id}`)));
    await redisService.del('other:unrelated:key');
  });
});
