/**
 * =============================================================================
 * F-B-08 — clusterScanAll cluster fan-out test
 * =============================================================================
 *
 * Verifies:
 *  - In single-node mode (no .nodes() API on the raw client), the generator
 *    collapses to redisService.scanIterator semantics and yields every key.
 *  - In cluster mode (raw client exposes .nodes('master') returning multiple
 *    node stubs with disjoint key sets), clusterScanAll yields the UNION of
 *    keys across all masters — the key guarantee that the legacy
 *    redisService.keys() path violated.
 *  - With FF_CLUSTER_SCAN_FANOUT=false (emergency rollback), the generator
 *    forces the single-node path even against a cluster client.
 * =============================================================================
 */

// ---- Mocks must be declared BEFORE importing the unit under test ----
let mockRawClient: any = null;
const mockScanIterator = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    getClient: () => mockRawClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scanIterator: (pattern: string, count?: number) => mockScanIterator(pattern, count),
  },
}));

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { clusterScanAll, clusterScanAllFlat } from '../shared/services/redis-cluster-scan';

// ---- Helpers ----
async function* asyncIterFromArray(arr: string[]): AsyncIterableIterator<string> {
  for (const k of arr) yield k;
}

function makeNode(keys: string[]) {
  return {
    scan: jest.fn(async (_cursor: string, _m: string, pattern: string, _c: string, _count: number) => {
      const match = (k: string) => pattern === '*' || k.startsWith(pattern.replace(/\*$/, ''));
      const matched = keys.filter(match);
      return ['0', matched];
    }),
  };
}

beforeEach(() => {
  mockRawClient = null;
  mockScanIterator.mockReset();
  delete process.env.FF_CLUSTER_SCAN_FANOUT;
});

describe('F-B-08 clusterScanAll', () => {
  describe('single-node mode', () => {
    it('falls through to redisService.scanIterator when raw client has no .nodes()', async () => {
      mockRawClient = { scan: jest.fn() }; // no .nodes(), no slots
      mockScanIterator.mockImplementation((pattern: string) =>
        asyncIterFromArray(['geo:transporters:a', 'geo:transporters:b'])
      );

      const out = await clusterScanAllFlat('geo:transporters:*');
      expect(out.sort()).toEqual(['geo:transporters:a', 'geo:transporters:b']);
      expect(mockScanIterator).toHaveBeenCalledTimes(1);
    });

    it('falls through when getClient returns null (degraded/in-memory)', async () => {
      mockRawClient = null;
      mockScanIterator.mockImplementation((pattern: string) =>
        asyncIterFromArray(['fleet:1', 'fleet:2', 'fleet:3'])
      );

      const keys = await clusterScanAllFlat('fleet:*');
      expect(keys.sort()).toEqual(['fleet:1', 'fleet:2', 'fleet:3']);
    });
  });

  describe('cluster mode', () => {
    it('returns the UNION of keys across 3 master nodes (disjoint keysets)', async () => {
      const nodeA = makeNode(['geo:transporters:a1', 'geo:transporters:a2']);
      const nodeB = makeNode(['geo:transporters:b1']);
      const nodeC = makeNode(['geo:transporters:c1', 'geo:transporters:c2', 'geo:transporters:c3']);

      mockRawClient = {
        slots: [], // marks as cluster
        nodes: jest.fn((role: string) => (role === 'master' ? [nodeA, nodeB, nodeC] : [])),
      };

      const keys = await clusterScanAllFlat('geo:transporters:*');
      expect(keys.sort()).toEqual([
        'geo:transporters:a1',
        'geo:transporters:a2',
        'geo:transporters:b1',
        'geo:transporters:c1',
        'geo:transporters:c2',
        'geo:transporters:c3',
      ]);
      expect(mockRawClient.nodes).toHaveBeenCalledWith('master');
      expect(nodeA.scan).toHaveBeenCalled();
      expect(nodeB.scan).toHaveBeenCalled();
      expect(nodeC.scan).toHaveBeenCalled();
      // Single-node path must NOT have been used.
      expect(mockScanIterator).not.toHaveBeenCalled();
    });

    it('continues when one node throws (partial fleet still enumerated)', async () => {
      const nodeOk = makeNode(['ok:1', 'ok:2']);
      const nodeBad = { scan: jest.fn(async () => { throw new Error('MOVED'); }) };

      mockRawClient = {
        slots: [],
        nodes: jest.fn(() => [nodeBad, nodeOk]),
      };

      const keys = await clusterScanAllFlat('*');
      expect(keys.sort()).toEqual(['ok:1', 'ok:2']);
    });

    it('falls back to single-node when cluster.nodes("master") returns empty', async () => {
      mockRawClient = {
        slots: [],
        nodes: jest.fn(() => []),
      };
      mockScanIterator.mockImplementation(() => asyncIterFromArray(['single:1']));

      const keys = await clusterScanAllFlat('single:*');
      expect(keys).toEqual(['single:1']);
    });
  });

  describe('feature flag rollback (FF_CLUSTER_SCAN_FANOUT=false)', () => {
    it('forces single-node path even against a cluster client', async () => {
      process.env.FF_CLUSTER_SCAN_FANOUT = 'false';

      const nodeA = makeNode(['should:not:be:seen']);
      mockRawClient = {
        slots: [],
        nodes: jest.fn(() => [nodeA]),
      };
      mockScanIterator.mockImplementation(() => asyncIterFromArray(['legacy:1']));

      const keys = await clusterScanAllFlat('*');
      expect(keys).toEqual(['legacy:1']);
      expect(nodeA.scan).not.toHaveBeenCalled();
      expect(mockScanIterator).toHaveBeenCalledTimes(1);
    });
  });

  describe('generator form (streaming batches)', () => {
    it('yields batches per master node (no global buffering)', async () => {
      const nodeA = makeNode(['a:1', 'a:2']);
      const nodeB = makeNode(['b:1']);
      mockRawClient = { slots: [], nodes: jest.fn(() => [nodeA, nodeB]) };

      const batches: string[][] = [];
      for await (const batch of clusterScanAll('*')) batches.push(batch);

      // 2 non-empty batches (one per node in our stubs — a single SCAN iter each)
      expect(batches.length).toBeGreaterThanOrEqual(1);
      const flat = batches.flat().sort();
      expect(flat).toEqual(['a:1', 'a:2', 'b:1']);
    });
  });
});
