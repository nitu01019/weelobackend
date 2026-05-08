/**
 * =============================================================================
 * Fix #20 — Outbox leader poller MUST fail-CLOSED on Redis error
 * =============================================================================
 *
 * §1.5 of /Users/nitishbhardwaj/Downloads/index-20-validated.md.
 *
 * Bug pre-fix: BOTH the fenced and legacy election catch blocks set
 * `isLeader = true` ('proceeding as fallback') on Redis error. During
 * ElastiCache transient errors (TLS resets >20KB packets, MOVED slot
 * relocation, backup-window CPU spikes — routine per AWS docs) all 6 pods
 * become leader simultaneously → 6× DB hammer + 6× heartbeat storm + duplicate
 * dispatches.
 *
 * Fix: replace `isLeader = true` with `return;` in BOTH catch blocks AND
 * increment `outbox_leader_election_redis_error_total` with `{ path: 'fenced' }`
 * or `{ path: 'legacy' }` label.
 *
 * Verification at HEAD `8647f10f`:
 *   - `order-dispatch-outbox.service.ts:543` → `metrics.incrementCounter('outbox_leader_election_redis_error_total', { path: 'fenced' }); return;`
 *   - `order-dispatch-outbox.service.ts:570` → same with `{ path: 'legacy' }; return;`
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — UNIQUE module-scope names per Pearl-blindspot lesson:
//   mockIncrementCounter_20 (NOT plain `mockIncrementCounter`)
//   mockEval_20, mockSetNxEx_20, etc.
// ---------------------------------------------------------------------------

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockIncrementCounter_20 = jest.fn();
const mockObserveHistogram_20 = jest.fn();
const mockSetGauge_20 = jest.fn();

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: mockIncrementCounter_20,
    observeHistogram: mockObserveHistogram_20,
    recordHistogram: jest.fn(),
    setGauge: mockSetGauge_20,
  },
}));

// =============================================================================
// SOURCE-FILE CONTRACT — verify catch blocks return + increment counter.
// =============================================================================

const SRC_DISPATCH_PATH_20 = path.resolve(
  __dirname,
  '../modules/order/order-dispatch-outbox.service.ts'
);

function stripComments_20(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Fix #20 — source contract: fenced + legacy catch blocks fail CLOSED', () => {
  const src_20_raw = fs.readFileSync(SRC_DISPATCH_PATH_20, 'utf-8');
  const src_20 = stripComments_20(src_20_raw);

  /** Find the catch block that immediately follows the renewLeader/acquireLeader
   *  block under `if (FF_OUTBOX_LEADER_FENCING)`. Walks brace depth from the
   *  fenced if-block's opening brace. */
  function findFencedCatch_20(src: string): { start: number; end: number } {
    const ifIdx = src.indexOf('if (FF_OUTBOX_LEADER_FENCING)');
    expect(ifIdx).toBeGreaterThan(-1);
    // Find the `} catch` AFTER the fenced try-block. The first `} catch` after
    // `if (FF_OUTBOX_LEADER_FENCING)` is the fenced one.
    const catchIdx = src.indexOf('} catch', ifIdx);
    expect(catchIdx).toBeGreaterThan(ifIdx);
    // The catch body opens at the next `{`.
    const bodyOpen = src.indexOf('{', catchIdx);
    expect(bodyOpen).toBeGreaterThan(catchIdx);
    let depth = 1;
    for (let i = bodyOpen + 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return { start: bodyOpen, end: i + 1 };
      }
    }
    throw new Error('unbalanced braces — fenced catch not found');
  }

  function findLegacyCatch_20(src: string): { start: number; end: number } {
    // Skip past the fenced catch first.
    const fenced = findFencedCatch_20(src);
    const catchIdx = src.indexOf('} catch', fenced.end);
    expect(catchIdx).toBeGreaterThan(fenced.end);
    const bodyOpen = src.indexOf('{', catchIdx);
    expect(bodyOpen).toBeGreaterThan(catchIdx);
    let depth = 1;
    for (let i = bodyOpen + 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return { start: bodyOpen, end: i + 1 };
      }
    }
    throw new Error('unbalanced braces — legacy catch not found');
  }

  it('fenced catch increments outbox_leader_election_redis_error_total with { path: "fenced" }', () => {
    const { start, end } = findFencedCatch_20(src_20);
    const body = src_20.substring(start, end);
    expect(body).toMatch(/outbox_leader_election_redis_error_total/);
    // The path label must be 'fenced' (so dashboards can split fenced vs legacy).
    expect(body).toMatch(/path\s*:\s*['"]fenced['"]/);
  });

  it('fenced catch ENDS with `return;` (fail-closed) — NOT `isLeader = true`', () => {
    const { start, end } = findFencedCatch_20(src_20);
    const body = src_20.substring(start, end);
    expect(body).toMatch(/\breturn\s*;/);
    // The pre-fix bug was setting `isLeader = true` in this catch — it MUST be gone.
    expect(body).not.toMatch(/isLeader\s*=\s*true/);
  });

  it('legacy catch increments outbox_leader_election_redis_error_total with { path: "legacy" }', () => {
    const { start, end } = findLegacyCatch_20(src_20);
    const body = src_20.substring(start, end);
    expect(body).toMatch(/outbox_leader_election_redis_error_total/);
    expect(body).toMatch(/path\s*:\s*['"]legacy['"]/);
  });

  it('legacy catch ENDS with `return;` (fail-closed) — NOT `isLeader = true`', () => {
    const { start, end } = findLegacyCatch_20(src_20);
    const body = src_20.substring(start, end);
    expect(body).toMatch(/\breturn\s*;/);
    expect(body).not.toMatch(/isLeader\s*=\s*true/);
  });

  it('NO surviving `proceeding as fallback` log line in either catch block (the pre-fix breadcrumb)', () => {
    // The pre-fix log message was 'proceeding as fallback'. It is the exact
    // string that lit up CloudWatch during the every-pod-is-leader incidents.
    expect(src_20).not.toMatch(/proceeding\s+as\s+fallback/i);
  });
});

// =============================================================================
// RUNTIME — exercise processDispatchOutboxBatch on both flag paths and assert:
//   1. catch block returns early (no claim query runs).
//   2. counter increments with the correct `path` label.
// =============================================================================

// We need to mock everything `order-dispatch-outbox.service.ts` imports, then
// drive renew/acquire to throw so the catch executes.

const mockRenewLeader_20 = jest.fn();
const mockAcquireLeader_20 = jest.fn();
const mockStartHeartbeat_20 = jest.fn(
  (_k: string, _i: string, _t: number, _iv: number): NodeJS.Timeout => {
    const t = setInterval(() => {}, 60_000);
    (t as unknown as { unref: () => void }).unref();
    return t as unknown as NodeJS.Timeout;
  }
);

jest.mock('../shared/services/leader-election.service', () => ({
  acquireLeader: (k: string, i: string, t: number) => mockAcquireLeader_20(k, i, t),
  renewLeader: (k: string, i: string, t: number) => mockRenewLeader_20(k, i, t),
  startHeartbeat: (k: string, i: string, t: number, iv: number) => mockStartHeartbeat_20(k, i, t, iv),
  LEADER_RENEW_SCRIPT: 'fake-cas-script',
}));

const mockClaimRows_20 = jest.fn().mockResolvedValue([]);
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    eval: jest.fn(),
    setNxEx: jest.fn(),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    orderDispatchOutbox: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

describe('Fix #20 — runtime: fenced catch fails CLOSED', () => {
  let processBatch_20: (limit?: number) => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FF_ORDER_DISPATCH_OUTBOX = 'true';
    process.env.FF_OUTBOX_LEADER_FENCING = 'true';
    process.env.OUTBOX_LEADER_TTL_SECONDS = '60';
    process.env.OUTBOX_LEADER_HEARTBEAT_MS = '20000';

    jest.isolateModules(() => {
      const mod = require('../modules/order/order-dispatch-outbox.service');
      processBatch_20 = mod.processDispatchOutboxBatch;
    });
  });

  it('renewLeader throws → returns early; counter increments with { path: "fenced" }', async () => {
    mockRenewLeader_20.mockRejectedValueOnce(new Error('connection refused'));

    await processBatch_20();

    // Counter call inspection — find the relevant call.
    const counterCalls = mockIncrementCounter_20.mock.calls.filter(
      (c) => c[0] === 'outbox_leader_election_redis_error_total'
    );
    expect(counterCalls.length).toBeGreaterThan(0);
    expect(counterCalls[0][1]).toEqual(expect.objectContaining({ path: 'fenced' }));

    // No row claim should have happened — fail-closed means we never proceeded.
    const claimRaw = require('../shared/database/prisma.service').prismaClient.$queryRaw;
    expect(claimRaw).not.toHaveBeenCalled();
  });
});

describe('Fix #20 — runtime: legacy catch fails CLOSED', () => {
  let processBatch_20_legacy: (limit?: number) => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FF_ORDER_DISPATCH_OUTBOX = 'true';
    // Legacy path = fencing flag OFF.
    process.env.FF_OUTBOX_LEADER_FENCING = 'false';

    jest.isolateModules(() => {
      const mod = require('../modules/order/order-dispatch-outbox.service');
      processBatch_20_legacy = mod.processDispatchOutboxBatch;
    });
  });

  it('acquireLeader throws → returns early; counter increments with { path: "legacy" }', async () => {
    mockAcquireLeader_20.mockRejectedValueOnce(new Error('redis timeout'));

    await processBatch_20_legacy();

    const counterCalls = mockIncrementCounter_20.mock.calls.filter(
      (c) => c[0] === 'outbox_leader_election_redis_error_total'
    );
    expect(counterCalls.length).toBeGreaterThan(0);
    expect(counterCalls[0][1]).toEqual(expect.objectContaining({ path: 'legacy' }));

    const claimRaw = require('../shared/database/prisma.service').prismaClient.$queryRaw;
    expect(claimRaw).not.toHaveBeenCalled();
  });

  it('acquireLeader returns false (lease held elsewhere) → returns early; NO error counter', async () => {
    mockAcquireLeader_20.mockResolvedValueOnce(false);

    await processBatch_20_legacy();

    const counterCalls = mockIncrementCounter_20.mock.calls.filter(
      (c) => c[0] === 'outbox_leader_election_redis_error_total'
    );
    // NOT an error — just a lost election. The counter is reserved for true Redis errors.
    expect(counterCalls.length).toBe(0);
  });
});

export {};
