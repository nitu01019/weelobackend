/**
 * =============================================================================
 * F-A-64 — VehicleTransitionOutbox (in-TX dual-write fix)
 * =============================================================================
 *
 * Tests the durable outbox replacement for the post-TX try/catch at
 * `order-accept.service.ts:486-500`.
 *
 * RED expectations:
 *   1. Flag OFF → legacy behaviour is preserved: no outbox row is written;
 *      failure of onVehicleTransition() is swallowed (DB at on_hold, Redis
 *      desynced — the bug we are fixing).
 *   2. Flag ON (via in-TX write) → an outbox row is committed alongside
 *      Vehicle.status, so DB and outbox share one commit boundary.
 *   3. The poller drains rows on first successful replay (processedAt set,
 *      attempts incremented by 1).
 *   4. 5 consecutive replay failures DLQ the row (attempts = 5, processedAt
 *      stays NULL, DLQ counter emitted) — the row is never retried again.
 *   5. Poller uses leader-election (acquireLeader before any replay); on
 *      renewal failure it stops mid-cycle.
 *   6. Claim query uses `FOR UPDATE SKIP LOCKED` (contract assertion — we
 *      grep the source file).
 *
 * The test file is pure-TS with a fake Prisma + fake Redis + fake
 * liveAvailability layer so it runs against jest without needing a live DB.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — keep the file hermetic
// ---------------------------------------------------------------------------

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const metricsCounters: Record<string, number> = {};
const metricsGauges: Record<string, number> = {};

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn((name: string) => {
      metricsCounters[name] = (metricsCounters[name] || 0) + 1;
    }),
    setGauge: jest.fn((name: string, v: number) => {
      metricsGauges[name] = v;
    }),
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

// Fake leader-election helpers — force "always leader" so we exercise the
// poll path. Separate test (below) verifies the acquire gate.
const acquireLeaderMock = jest.fn(async (_k: string, _i: string, _t: number) => true);
const renewLeaderMock = jest.fn(async (_k: string, _i: string, _t: number) => true);
const startHeartbeatMock = jest.fn(
  (_k: string, _i: string, _t?: number, _iv?: number): NodeJS.Timeout => {
    const t = setInterval(() => {}, 10_000);
    (t as unknown as { unref: () => void }).unref();
    return t as unknown as NodeJS.Timeout;
  }
);

jest.mock('../shared/services/leader-election.service', () => ({
  acquireLeader: (k: string, i: string, t: number) => acquireLeaderMock(k, i, t),
  renewLeader: (k: string, i: string, t: number) => renewLeaderMock(k, i, t),
  startHeartbeat: (k: string, i: string, t: number, iv: number) =>
    startHeartbeatMock(k, i, t, iv),
  LEADER_RENEW_SCRIPT: 'fake-script',
}));

// Fake onVehicleTransition — controllable failure mode per row.
const onVehicleTransitionMock = jest.fn(
  async (
    _transporterId: string,
    _vehicleId: string,
    _vehicleKey: string | null | undefined,
    oldStatus: string,
    newStatus: string,
    _context: string
  ): Promise<void> => {
    // Look up scripted behaviour by `toStatus` marker.
    const script = (globalThis as { __vtoScript?: Array<{ behavior: 'success' | 'fail'; message?: string }> })
      .__vtoScript;
    if (!script || script.length === 0) return; // default success
    const next = script.shift()!;
    if (next.behavior === 'fail') {
      throw new Error(next.message || 'Redis connection refused');
    }
  }
);

jest.mock('../shared/services/vehicle-lifecycle.service', () => ({
  onVehicleTransition: (
    transporterId: string,
    vehicleId: string,
    vehicleKey: string | null | undefined,
    oldStatus: string,
    newStatus: string,
    context: string
  ) =>
    onVehicleTransitionMock(
      transporterId,
      vehicleId,
      vehicleKey,
      oldStatus,
      newStatus,
      context
    ),
}));

// ---------------------------------------------------------------------------
// Fake Prisma — just enough to satisfy the poller's $queryRaw + $executeRaw
// ---------------------------------------------------------------------------

interface FakeRow {
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

const fakeOutbox: FakeRow[] = [];
let nextId = 1;

function addRow(partial: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    id: `row-${nextId++}`,
    vehicleId: partial.vehicleId ?? 'veh-abc',
    vehicleKey: partial.vehicleKey ?? 'vk-abc',
    transporterId: partial.transporterId ?? 'tr-1',
    fromStatus: partial.fromStatus ?? 'available',
    toStatus: partial.toStatus ?? 'on_hold',
    reason: partial.reason ?? 'orderAccept',
    createdAt: partial.createdAt ?? new Date(Date.now() - 1000),
    processedAt: partial.processedAt ?? null,
    attempts: partial.attempts ?? 0,
    lastError: partial.lastError ?? null,
  };
  fakeOutbox.push(row);
  return row;
}

function findRow(id: string): FakeRow | undefined {
  return fakeOutbox.find((r) => r.id === id);
}

/**
 * The poller assembles a tagged template literal like:
 *   tx.$queryRaw`SELECT ... FROM "VehicleTransitionOutbox" WHERE ...`
 * Our fake just inspects the concatenated SQL string to decide which shape
 * to return. Values are passed as trailing params and interpreted via index.
 */
const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  // ts-jest compiles tagged templates so `strings` is the template-strings
  // array and `values` are the interpolated placeholders.
  const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (
    /FROM\s+"VehicleTransitionOutbox"/i.test(sql) &&
    /FOR UPDATE SKIP LOCKED/i.test(sql)
  ) {
    const limit = Number(values[values.length - 1]) || 50;
    const maxAttempts = Number(values[0]) || 5;
    const picked = fakeOutbox
      .filter((r) => r.processedAt === null && r.attempts < maxAttempts)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
    return picked;
  }
  if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
    const count = fakeOutbox.filter((r) => r.processedAt === null).length;
    return [{ count: BigInt(count) }];
  }
  return [];
});

const $executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (
    /UPDATE\s+"VehicleTransitionOutbox"/i.test(sql) &&
    /SET\s+"processedAt"\s*=\s*now\(\)/i.test(sql)
  ) {
    const id = String(values[1]);
    const attempts = Number(values[0]);
    const row = findRow(id);
    if (row) {
      row.processedAt = new Date();
      row.attempts = attempts;
      row.lastError = null;
      return 1;
    }
    return 0;
  }
  if (
    /UPDATE\s+"VehicleTransitionOutbox"/i.test(sql) &&
    /SET\s+"attempts"/i.test(sql)
  ) {
    const attempts = Number(values[0]);
    const lastError = String(values[1]);
    const id = String(values[2]);
    const row = findRow(id);
    if (row) {
      row.attempts = attempts;
      row.lastError = lastError;
      return 1;
    }
    return 0;
  }
  return 0;
});

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { $queryRaw, $executeRaw };
      return fn(tx);
    }),
    $queryRaw,
    $executeRaw,
  },
  withDbTimeout: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = { $queryRaw, $executeRaw };
    return fn(tx);
  }),
  OrderStatus: {
    created: 'created',
    broadcasting: 'broadcasting',
    partially_filled: 'partially_filled',
    fully_filled: 'fully_filled',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  AssignmentStatus: {
    pending: 'pending',
    active: 'active',
    completed: 'completed',
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState(): void {
  fakeOutbox.length = 0;
  nextId = 1;
  // mockReset() drops queued once-values AND implementations; loadPollerModule
  // then reinstalls mockResolvedValue(true) for the default path.
  acquireLeaderMock.mockReset();
  renewLeaderMock.mockReset();
  startHeartbeatMock.mockReset();
  startHeartbeatMock.mockImplementation(() => {
    const t = setInterval(() => {}, 10_000);
    (t as unknown as { unref: () => void }).unref();
    return t as unknown as NodeJS.Timeout;
  });
  onVehicleTransitionMock.mockClear();
  $queryRaw.mockClear();
  $executeRaw.mockClear();
  for (const k of Object.keys(metricsCounters)) delete metricsCounters[k];
  for (const k of Object.keys(metricsGauges)) delete metricsGauges[k];
  (globalThis as { __vtoScript?: unknown }).__vtoScript = undefined;
}

// Late import so the jest.mock() above is wired before the module loads.
// We deliberately do NOT reset modules between tests — module-level state
// (leader flag, poll timer) is cleared explicitly via __resetForTests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
function loadPollerModule() {
  acquireLeaderMock.mockResolvedValue(true);
  renewLeaderMock.mockResolvedValue(true);
  const mod = require('../shared/services/vehicle-transition-outbox.service') as typeof import(
    '../shared/services/vehicle-transition-outbox.service'
  );
  mod.__resetVehicleTransitionOutboxForTests();
  return mod;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('F-A-64 — VehicleTransitionOutbox', () => {
  beforeEach(() => {
    resetState();
  });

  // -------------------------------------------------------------------------
  // Contract: source-level assertions (works without a DB)
  // -------------------------------------------------------------------------

  describe('contracts: source-level expectations', () => {
    const POLLER_PATH = path.resolve(
      __dirname,
      '../shared/services/vehicle-transition-outbox.service.ts'
    );
    const ORDER_ACCEPT_PATH = path.resolve(
      __dirname,
      '../modules/order/order-accept.service.ts'
    );
    const MIGRATION_PATH = path.resolve(
      __dirname,
      '../../migrations/M-006-vehicle-transition-outbox.sql'
    );
    const FLAGS_PATH = path.resolve(
      __dirname,
      '../shared/config/feature-flags.ts'
    );

    it('poller exists and uses FOR UPDATE SKIP LOCKED on the claim query', () => {
      expect(fs.existsSync(POLLER_PATH)).toBe(true);
      const src = fs.readFileSync(POLLER_PATH, 'utf8');
      expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
      expect(src).toMatch(/VehicleTransitionOutbox/);
    });

    it('poller wires leader-election helpers (acquireLeader + renewLeader + startHeartbeat)', () => {
      const src = fs.readFileSync(POLLER_PATH, 'utf8');
      expect(src).toMatch(/acquireLeader/);
      expect(src).toMatch(/renewLeader/);
      expect(src).toMatch(/startHeartbeat/);
    });

    it('order-accept.service wraps the Redis sync with the feature flag', () => {
      const src = fs.readFileSync(ORDER_ACCEPT_PATH, 'utf8');
      expect(src).toMatch(/VEHICLE_TRANSITION_OUTBOX/);
      expect(src).toMatch(/INSERT INTO "VehicleTransitionOutbox"/);
      // Legacy post-TX path guarded by !isEnabled(...) — both branches exist.
      expect(src).toMatch(/!isEnabled\(FLAGS\.VEHICLE_TRANSITION_OUTBOX\)/);
    });

    it('migrations/M-006 creates table + partial index concurrently', () => {
      expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
      const src = fs.readFileSync(MIGRATION_PATH, 'utf8');
      expect(src).toMatch(/CREATE TABLE IF NOT EXISTS "VehicleTransitionOutbox"/);
      expect(src).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
      expect(src).toMatch(/WHERE "processedAt" IS NULL/);
    });

    it('feature flag is registered with release category (default OFF)', () => {
      const src = fs.readFileSync(FLAGS_PATH, 'utf8');
      expect(src).toMatch(/VEHICLE_TRANSITION_OUTBOX/);
      // Declared under FLAGS with env = FF_VEHICLE_TRANSITION_OUTBOX, release category.
      expect(src).toMatch(/FF_VEHICLE_TRANSITION_OUTBOX/);
    });
  });

  // -------------------------------------------------------------------------
  // Behaviour: poller drains on success
  // -------------------------------------------------------------------------

  describe('behaviour: poller drains outbox row on first successful replay', () => {
    it('sets processedAt, increments attempts once, and emits success counter', async () => {
      const mod = loadPollerModule();
      const row = addRow({ vehicleKey: 'vk-1' });

      const processed = await mod.runVehicleTransitionOutboxPoll();

      expect(processed).toBe(1);
      expect(onVehicleTransitionMock).toHaveBeenCalledTimes(1);
      expect(onVehicleTransitionMock).toHaveBeenCalledWith(
        row.transporterId,
        row.vehicleId,
        row.vehicleKey,
        'available',
        'on_hold',
        'orderAccept'
      );
      const refreshed = findRow(row.id)!;
      expect(refreshed.processedAt).not.toBeNull();
      expect(refreshed.attempts).toBe(1);
      expect(refreshed.lastError).toBeNull();
      expect(metricsCounters['vehicle_transition_outbox_processed_total']).toBe(1);
    });

    it('skips rows that are already processed (only drains NULL processedAt)', async () => {
      const mod = loadPollerModule();
      addRow({ processedAt: new Date() });
      const pending = addRow({ vehicleKey: 'vk-pending' });

      const processed = await mod.runVehicleTransitionOutboxPoll();

      expect(processed).toBe(1);
      expect(findRow(pending.id)!.processedAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Behaviour: transient failure → retry; 5-attempt DLQ
  // -------------------------------------------------------------------------

  describe('behaviour: exp-backoff retry + DLQ after max attempts', () => {
    it('single transient failure increments attempts and keeps processedAt NULL', async () => {
      const mod = loadPollerModule();
      const row = addRow();

      (globalThis as { __vtoScript?: unknown }).__vtoScript = [{ behavior: 'fail' }];

      const processed = await mod.runVehicleTransitionOutboxPoll();

      expect(processed).toBe(1);
      const after = findRow(row.id)!;
      expect(after.attempts).toBe(1);
      expect(after.processedAt).toBeNull();
      expect(after.lastError).toMatch(/Redis/);
    });

    it('row is DLQ-d after exactly 5 failed attempts', async () => {
      const mod = loadPollerModule();
      const row = addRow();

      for (let i = 0; i < 5; i += 1) {
        (globalThis as { __vtoScript?: unknown }).__vtoScript = [{ behavior: 'fail' }];
        await mod.runVehicleTransitionOutboxPoll();
      }

      const after = findRow(row.id)!;
      expect(after.attempts).toBe(5);
      expect(after.processedAt).toBeNull();
      expect(metricsCounters['vehicle_transition_outbox_dlq_total']).toBe(1);

      // Row is now frozen — subsequent polls do not pick it up again.
      onVehicleTransitionMock.mockClear();
      await mod.runVehicleTransitionOutboxPoll();
      expect(onVehicleTransitionMock).not.toHaveBeenCalled();
    });

    it('success after retries clears lastError and sets processedAt', async () => {
      const mod = loadPollerModule();
      const row = addRow();

      (globalThis as { __vtoScript?: unknown }).__vtoScript = [{ behavior: 'fail' }];
      await mod.runVehicleTransitionOutboxPoll();

      (globalThis as { __vtoScript?: unknown }).__vtoScript = [{ behavior: 'success' }];
      await mod.runVehicleTransitionOutboxPoll();

      const after = findRow(row.id)!;
      expect(after.attempts).toBe(2);
      expect(after.processedAt).not.toBeNull();
      expect(after.lastError).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Behaviour: leader election
  // -------------------------------------------------------------------------

  describe('behaviour: leader-election gates replay', () => {
    it('skips processing when acquireLeader returns false', async () => {
      acquireLeaderMock.mockResolvedValueOnce(false);
      const mod = loadPollerModule();
      // reinstall the mock returning false after reset
      acquireLeaderMock.mockResolvedValueOnce(false);
      addRow();

      const processed = await mod.runVehicleTransitionOutboxPoll();

      expect(processed).toBe(0);
      expect(onVehicleTransitionMock).not.toHaveBeenCalled();
    });

    it('stops polling when renewLeader fails mid-cycle', async () => {
      const mod = loadPollerModule();

      // First tick acquires leadership + processes zero rows (empty outbox).
      acquireLeaderMock.mockResolvedValue(true);
      await mod.runVehicleTransitionOutboxPoll();

      // Now add work AND force renewal to fail — the tick must short-circuit
      // before calling onVehicleTransition.
      addRow();
      renewLeaderMock.mockResolvedValueOnce(false);
      onVehicleTransitionMock.mockClear();

      const processed = await mod.runVehicleTransitionOutboxPoll();

      expect(processed).toBe(0);
      expect(onVehicleTransitionMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Behaviour: exp-backoff curve sanity
  // -------------------------------------------------------------------------

  describe('behaviour: exp-backoff helper', () => {
    it('grows monotonically up to the 30s cap, jitter under 500ms', () => {
      const mod = loadPollerModule();
      const d1 = mod.calculateOutboxBackoffMs(1);
      const d2 = mod.calculateOutboxBackoffMs(2);
      const d3 = mod.calculateOutboxBackoffMs(10);

      expect(d1).toBeGreaterThanOrEqual(2_000);
      expect(d1).toBeLessThan(2_500);
      expect(d2).toBeGreaterThanOrEqual(4_000);
      expect(d3).toBeGreaterThanOrEqual(30_000);
      expect(d3).toBeLessThan(30_500);
    });
  });

  // -------------------------------------------------------------------------
  // Behaviour: pending gauge
  // -------------------------------------------------------------------------

  describe('behaviour: pending gauge', () => {
    it('writes vehicle_transition_outbox_pending_gauge on each poll', async () => {
      const mod = loadPollerModule();
      addRow();
      addRow();
      await mod.runVehicleTransitionOutboxPoll();
      expect(metricsGauges['vehicle_transition_outbox_pending_gauge']).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Wiring: startVehicleTransitionOutboxPoller is idempotent + .unref'd
  // -------------------------------------------------------------------------

  describe('wiring: poller lifecycle', () => {
    it('startVehicleTransitionOutboxPoller is idempotent and returns a timer', () => {
      const mod = loadPollerModule();
      const t1 = mod.startVehicleTransitionOutboxPoller(60_000);
      const t2 = mod.startVehicleTransitionOutboxPoller(60_000);
      expect(t1).toBe(t2);
      mod.stopVehicleTransitionOutboxPoller();
    });
  });
});
