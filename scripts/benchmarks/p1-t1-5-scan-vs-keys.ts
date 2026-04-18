/**
 * P1-T1.5 SC8 benchmark — wall-clock + event-loop lag comparison between the
 * old `keys()` code-path and the new `scanIterator()` code-path across a
 * 100k-key synthetic keyspace.
 *
 * Run: `node_modules/.bin/ts-node --transpile-only scripts/benchmarks/p1-t1-5-scan-vs-keys.ts`
 *
 * NOTE: Standalone harness for producing PR-body benchmark evidence. Not a
 * Jest test; does not assert.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const BATCH_COUNT = 200;
const N_KEYS = 100_000;

interface ScanLikeClient {
  scan(cursor: string, matchKey: 'MATCH', pattern: string, countKey: 'COUNT', count: number): Promise<[string, string[]]>;
  keys(pattern: string): Promise<string[]>;
}

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
    const matcher = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    for (let i = start; i < end; i += 1) if (matcher.test(this.store[i])) batch.push(this.store[i]);
    const next = end >= this.store.length ? '0' : String(end);
    await Promise.resolve();
    return [next, batch];
  }

  async keys(pattern: string): Promise<string[]> {
    const matcher = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return this.store.filter((k) => matcher.test(k));
  }
}

async function* scanIterator(
  client: ScanLikeClient,
  pattern: string,
  count = BATCH_COUNT,
): AsyncIterableIterator<string> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const key of keys) yield key;
  } while (cursor !== '0');
}

async function measure(
  label: string,
  work: () => Promise<number>,
): Promise<{ label: string; totalMs: number; p50: number; p99: number; count: number }> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const count = await work();
  const totalMs = performance.now() - t0;
  h.disable();
  return {
    label,
    totalMs,
    p50: h.percentile(50) / 1e6,
    p99: h.percentile(99) / 1e6,
    count,
  };
}

async function main(): Promise<void> {
  const seeded = Array.from({ length: N_KEYS }, (_, i) => `geo:transporters:v-${i}`);
  const client = new FakeRedisScanClient(seeded);

  const keysRun = await measure('keys()', async () => {
    const result = await client.keys('geo:transporters:*');
    return result.length;
  });

  const scanRun = await measure('scanIterator()', async () => {
    let collected = 0;
    for await (const _ of scanIterator(client, 'geo:transporters:*', BATCH_COUNT)) collected += 1;
    return collected;
  });

  const rows = [keysRun, scanRun].map((r) => ({
    path: r.label,
    keys_returned: r.count,
    total_ms: r.totalMs.toFixed(2),
    event_loop_p50_ms: r.p50.toFixed(2),
    event_loop_p99_ms: r.p99.toFixed(2),
  }));

  // eslint-disable-next-line no-console
  console.table(rows);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
