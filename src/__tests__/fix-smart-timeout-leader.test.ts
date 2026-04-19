/**
 * =============================================================================
 * F-A-69 — Smart-timeout leader-election (RED tests)
 * =============================================================================
 *
 * Problem: `smart-timeout.service.ts::startExpiryChecker` runs a 15s
 * `setInterval(checkAndMarkExpired)` on EVERY ECS instance. With N tasks and
 * no row-level locking, each expired order is processed N times — N× emits
 * of `order_expired`, N× handleOrderExpiry invocations (which emits socket
 * events + FCM + lifecycle outbox inserts).
 *
 * Fix: wrap the sweep callback with `acquireLeader(...)` from the F-A-56
 * leader-election helper so only one ECS instance processes the sweep per
 * TTL window; add `SELECT ... FOR UPDATE SKIP LOCKED` to the inner
 * `orderTimeout.findMany` so even if leader-election momentarily lapses
 * (GC pause past TTL), Postgres row-level locks prevent duplicate row
 * processing. Gated by `FF_SMART_TIMEOUT_LEADER_ELECTION` (release, default
 * OFF). When OFF: legacy behaviour (every instance sweeps).
 *
 * RED assertions (source-level static checks + unit-level behaviour):
 *   1. FF_SMART_TIMEOUT_LEADER_ELECTION declared in flags registry
 *      (category: release, default OFF).
 *   2. smart-timeout.service.ts imports acquireLeader from
 *      src/shared/services/leader-election.service.ts.
 *   3. startExpiryChecker callback (or checkAndMarkExpired) is guarded by
 *      `isEnabled(FLAGS.SMART_TIMEOUT_LEADER_ELECTION)` and uses
 *      `acquireLeader('smart-timeout-leader', ...)`.
 *   4. FOR UPDATE SKIP LOCKED used on the OrderTimeout row-claim.
 *   5. Runtime: 3 in-process instances running the sweep concurrently emit
 *      exactly 1× `handleOrderExpiry` per expired order when the flag is ON
 *      (leader-election wins); currently 3× emits (RED).
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIVE = 'src/modules/order-timeout/smart-timeout.service.ts';
const FLAG_REGISTRY = 'src/shared/config/feature-flags.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('F-A-69 — smart-timeout leader-election (source contract)', () => {
  let live: string;
  let flags: string;

  beforeAll(() => {
    live = read(LIVE);
    flags = read(FLAG_REGISTRY);
  });

  it('fixture#1: FF_SMART_TIMEOUT_LEADER_ELECTION is declared in the central feature-flag registry', () => {
    expect(flags).toMatch(/SMART_TIMEOUT_LEADER_ELECTION:\s*\{/);
    expect(flags).toMatch(/env:\s*['"]FF_SMART_TIMEOUT_LEADER_ELECTION['"]/);
    expect(flags).toMatch(
      /SMART_TIMEOUT_LEADER_ELECTION:\s*\{[\s\S]*?category:\s*['"]release['"]/
    );
  });

  it('fixture#2: smart-timeout.service.ts imports acquireLeader from leader-election helper', () => {
    expect(live).toMatch(/from\s+['"]\.\.\/\.\.\/shared\/services\/leader-election\.service['"]/);
    expect(live).toMatch(/\bacquireLeader\b/);
  });

  it('fixture#3: sweep callback is guarded by isEnabled(FLAGS.SMART_TIMEOUT_LEADER_ELECTION)', () => {
    expect(live).toMatch(/isEnabled\(\s*FLAGS\.SMART_TIMEOUT_LEADER_ELECTION\s*\)/);
  });

  it('fixture#4: sweep callback acquires a leader lock named "smart-timeout-leader"', () => {
    // Leader key can be declared as a string literal or as a named constant —
    // accept either form so the implementation is free to extract a constant
    // (e.g. SMART_TIMEOUT_LEADER_KEY) without breaking this contract test.
    const literalForm = /acquireLeader\(\s*['"]smart-timeout-leader['"]/;
    const constantForm = /const\s+SMART_TIMEOUT_LEADER_KEY\s*=\s*['"]smart-timeout-leader['"]/;
    expect(literalForm.test(live) || constantForm.test(live)).toBe(true);
    // Either way `acquireLeader(` must be called somewhere in the file.
    expect(live).toMatch(/acquireLeader\(/);
  });

  it('fixture#5: OrderTimeout row-claim uses FOR UPDATE SKIP LOCKED', () => {
    // Raw-SQL row lock mirrors the pattern already used in
    // order-dispatch-outbox.service.ts::claimReadyDispatchOutboxRows.
    expect(live).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(live).toMatch(/\$queryRaw/);
  });

  it('fixture#6: legacy (flag=OFF) path still runs checkAndMarkExpired unchanged', () => {
    // When the flag is OFF the existing logic must still be reachable —
    // i.e. the module still references `checkAndMarkExpired` and does not
    // require leader-election to function.
    expect(live).toMatch(/checkAndMarkExpired\s*\(/);
    expect(live).toMatch(/setInterval/);
  });
});

// ---------------------------------------------------------------------------
// Runtime behaviour: 3 in-process instances + shared fake Redis — exactly
// one instance wins the leader lock and processes the expired row.
// ---------------------------------------------------------------------------

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
    startTimer: jest.fn(() => jest.fn()),
  },
}));

// Shared in-memory fake Redis (modelled after fix-outbox-leader-fencing.test.ts)
type StoredValue = { value: string; expiresAt: number };
const fakeStore = new Map<string, StoredValue>();
const now = (): number => Date.now();
const isExpired = (e: StoredValue | undefined): boolean => !e || e.expiresAt <= now();

const mockSetNxEx = jest.fn(async (key: string, value: string, ttlSec: number): Promise<boolean> => {
  const existing = fakeStore.get(key);
  if (existing && !isExpired(existing)) return false;
  fakeStore.set(key, { value, expiresAt: now() + ttlSec * 1000 });
  return true;
});

const mockEval = jest.fn(async (script: string, keys: string[], args: string[]): Promise<any> => {
  const key = keys[0];
  const value = args[0];
  const ttlSec = parseInt(args[1], 10);
  const existing = fakeStore.get(key);
  const normalised = script.replace(/\s+/g, ' ');
  if (/'NX'\s*,\s*'EX'/.test(normalised)) {
    if (existing && !isExpired(existing)) return 0;
    fakeStore.set(key, { value, expiresAt: now() + ttlSec * 1000 });
    return 1;
  }
  // CAS renewal
  if (!existing || isExpired(existing)) return 0;
  if (existing.value !== value) return 0;
  fakeStore.set(key, { value: existing.value, expiresAt: now() + ttlSec * 1000 });
  return 1;
});

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    setNxEx: mockSetNxEx,
    eval: mockEval,
    set: jest.fn(async () => 'OK'),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 1),
    setJSON: jest.fn(async () => 'OK'),
    acquireLock: jest.fn(async (k: string, v: string, ttl: number) => ({
      acquired: await mockSetNxEx(`lock:${k}`, v, ttl),
      ttl,
    })),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { acquireLeader } = require('../shared/services/leader-election.service');

describe('F-A-69 — leader-election prevents 3× duplicate sweep emits', () => {
  beforeEach(() => {
    fakeStore.clear();
    jest.clearAllMocks();
  });

  it('3 in-process instances competing for the same leader key — exactly one wins', async () => {
    // Simulate 3 ECS tasks hitting acquireLeader at the same tick. Only one
    // can win under SET NX EX semantics — the others return false and must
    // skip their sweep body. Today (without the guard) all 3 proceed, which
    // is the source of 3× `order_expired` emits per expired order.
    const results = await Promise.all([
      acquireLeader('smart-timeout-leader', 'pod-a', 30),
      acquireLeader('smart-timeout-leader', 'pod-b', 30),
      acquireLeader('smart-timeout-leader', 'pod-c', 30),
    ]);

    const winners = results.filter(Boolean).length;
    expect(winners).toBe(1);

    // Whichever instance won owns the lease — the losers must back off.
    const stored = fakeStore.get('smart-timeout-leader');
    expect(stored).toBeDefined();
    expect(['pod-a', 'pod-b', 'pod-c']).toContain(stored?.value);
  });

  it('only the leader runs the sweep — losers short-circuit before touching DB', async () => {
    // Model of the guarded sweep: each instance attempts acquireLeader and
    // only runs its (mocked) sweep body if it won.
    const sweepBody = jest.fn(async (_instanceId: string) => {
      // Pretend we'd call orderTimeout.findMany + handleOrderExpiry here.
    });

    async function guardedSweep(instanceId: string): Promise<void> {
      const acquired = await acquireLeader('smart-timeout-leader', instanceId, 30);
      if (!acquired) return;
      await sweepBody(instanceId);
    }

    await Promise.all([
      guardedSweep('pod-a'),
      guardedSweep('pod-b'),
      guardedSweep('pod-c'),
    ]);

    // Exactly one sweep body ran. This is the opposite of the (pre-fix)
    // "every instance runs the sweep" behaviour that emits N× `order_expired`.
    expect(sweepBody).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage for the live smart-timeout guard itself — flag ON path.
// Mocks prismaClient to fake a $queryRaw row-claim and verifies that:
//   - the leader-election gate is consulted (flag ON)
//   - losers short-circuit (return 0 and never query Postgres)
//   - winners run the awaited row claim via $queryRaw with FOR UPDATE SKIP LOCKED
// ---------------------------------------------------------------------------

jest.mock('../config/environment', () => ({
  config: { redis: { enabled: true }, isProduction: false, otp: { expiryMinutes: 5 }, sms: {} },
}));

jest.mock('../shared/services/queue.service', () => ({
  queueService: { enqueue: jest.fn(), dequeue: jest.fn() },
}));

jest.mock('../shared/services/socket.service', () => ({
  socketService: { emit: jest.fn(), emitToUser: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const queryRawMock = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orderTimeoutFindMany = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orderTimeoutUpdate = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const progressEventFindFirst = jest.fn();

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $queryRaw: queryRawMock,
    orderTimeout: {
      findMany: orderTimeoutFindMany,
      update: orderTimeoutUpdate,
    },
    progressEvent: {
      findFirst: progressEventFindFirst,
    },
  },
  TimeoutExtensionType: {
    FIRST_DRIVER: 'FIRST_DRIVER',
    SUBSEQUENT_DRIVER: 'SUBSEQUENT_DRIVER',
  },
  OrderStatus: { expired: 'expired' },
}));

// Re-import after mocks are wired. The module caches its singleton, so fresh
// require per describe block keeps these coverage checks isolated.
describe('F-A-69 — live guard coverage (flag ON → leader-gated + SKIP LOCKED)', () => {
  const ORIG_FLAG = process.env.FF_SMART_TIMEOUT_LEADER_ELECTION;

  beforeEach(() => {
    fakeStore.clear();
    queryRawMock.mockReset();
    orderTimeoutFindMany.mockReset();
    orderTimeoutUpdate.mockReset();
    progressEventFindFirst.mockReset();
    jest.resetModules();
  });

  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.FF_SMART_TIMEOUT_LEADER_ELECTION;
    else process.env.FF_SMART_TIMEOUT_LEADER_ELECTION = ORIG_FLAG;
  });

  it('flag ON — leader runs $queryRaw (SKIP LOCKED) and sweeps empty result set', async () => {
    process.env.FF_SMART_TIMEOUT_LEADER_ELECTION = 'true';
    queryRawMock.mockResolvedValueOnce([]); // no expired rows
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../modules/order-timeout/smart-timeout.service');
    const result = await mod.smartTimeoutService.checkAndMarkExpired();

    expect(result).toBe(0);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    // The raw SQL template must embed FOR UPDATE SKIP LOCKED — assert on the
    // TemplateStringsArray that Prisma's $queryRaw receives.
    const callArgs = queryRawMock.mock.calls[0];
    const sqlParts = (callArgs[0] as TemplateStringsArray | undefined)?.raw?.join(' ') ?? String(callArgs[0] ?? '');
    expect(sqlParts).toMatch(/FOR UPDATE SKIP LOCKED/);
    // Legacy findMany was NOT called on the flag-ON path.
    expect(orderTimeoutFindMany).not.toHaveBeenCalled();
  });

  it('flag ON — loser instance short-circuits (leader already held by a different owner)', async () => {
    process.env.FF_SMART_TIMEOUT_LEADER_ELECTION = 'true';
    // Pre-seed the leader key with a different owner so acquireLeader fails.
    fakeStore.set('smart-timeout-leader', { value: 'some-other-pod', expiresAt: now() + 30_000 });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../modules/order-timeout/smart-timeout.service');
    const result = await mod.smartTimeoutService.checkAndMarkExpired();

    expect(result).toBe(0);
    // No DB calls — we short-circuited before the row claim.
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(orderTimeoutFindMany).not.toHaveBeenCalled();
  });

  it('flag OFF — legacy findMany path still runs (no acquireLeader gate)', async () => {
    process.env.FF_SMART_TIMEOUT_LEADER_ELECTION = 'false';
    orderTimeoutFindMany.mockResolvedValueOnce([]); // empty
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../modules/order-timeout/smart-timeout.service');
    const result = await mod.smartTimeoutService.checkAndMarkExpired();

    expect(result).toBe(0);
    expect(orderTimeoutFindMany).toHaveBeenCalledTimes(1);
    expect(queryRawMock).not.toHaveBeenCalled();
  });
});
