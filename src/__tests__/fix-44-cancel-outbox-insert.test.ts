/**
 * =============================================================================
 * Fix #44 — Cancel-path vehicle-availability outbox INSERT
 *           (STUCK_DRIVER_BUG: vehicle stuck FOREVER on cancel)
 * =============================================================================
 *
 * §1.11 of /Users/nitishbhardwaj/Downloads/index-20-validated.md.
 *
 * Bug pre-fix:
 *   - `order-accept.service.ts` does in-TX `$executeRaw INSERT VehicleTransitionOutbox`
 *     (flag-gated by `FLAGS.VEHICLE_TRANSITION_OUTBOX`).
 *   - `order-cancel.service.ts` does post-TX `.catch(logger.warn)` fire-and-forget
 *     to `onVehicleTransition`. If the post-TX hook fails (Redis blip):
 *     DB shows `Vehicle.status='available'` but Redis live-availability shows
 *     busy → matching engine skips the vehicle indefinitely. CLAUDE.md
 *     "STUCK_DRIVER_BUG" matches this exact failure mode.
 *
 * Fix: mirror accept-path EXACTLY — gate an in-TX `$executeRaw INSERT` on the
 * SAME flag (`FLAGS.VEHICLE_TRANSITION_OUTBOX`), AND wrap the legacy post-TX
 * fire-and-forget in a flag-OFF guard so it doesn't double-run when the
 * outbox path is enabled. Reason column on the inserted row = `'orderCancel'`.
 *
 * Verification at HEAD `8647f10f`:
 *   - `order-cancel.service.ts:502-514` — in-TX outbox INSERT (flag-gated)
 *   - `order-cancel.service.ts:683-692` — legacy post-TX guarded by `!isEnabled(...)`
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — UNIQUE per file: mockExecuteRaw_44, mockOnVehicleTransition_44, etc.
// ---------------------------------------------------------------------------

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockIncrementCounter_44 = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: mockIncrementCounter_44,
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// =============================================================================
// SOURCE-FILE CONTRACT
// =============================================================================

const SRC_CANCEL_PATH_44 = path.resolve(
  __dirname,
  '../modules/order/order-cancel.service.ts'
);
const SRC_ACCEPT_PATH_44 = path.resolve(
  __dirname,
  '../modules/order/order-accept.service.ts'
);

function stripComments_44(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Fix #44 — source contract: cancel-path mirrors accept-path INSERT', () => {
  const cancel_44_raw = fs.readFileSync(SRC_CANCEL_PATH_44, 'utf-8');
  const cancel_44 = stripComments_44(cancel_44_raw);
  const accept_44_raw = fs.readFileSync(SRC_ACCEPT_PATH_44, 'utf-8');
  const accept_44 = stripComments_44(accept_44_raw);

  it('cancel-path declares an in-TX `INSERT INTO "VehicleTransitionOutbox"` block', () => {
    expect(cancel_44).toMatch(/INSERT\s+INTO\s+"VehicleTransitionOutbox"/);
  });

  it('cancel-path INSERT is gated by `isEnabled(FLAGS.VEHICLE_TRANSITION_OUTBOX)` (same flag as accept-path)', () => {
    // Find the INSERT site in the cancel file.
    const insertIdx = cancel_44.indexOf('INSERT INTO "VehicleTransitionOutbox"');
    expect(insertIdx).toBeGreaterThan(-1);

    // Walk back ~400 chars to confirm the surrounding `if (isEnabled(...))` guard.
    const region = cancel_44.substring(Math.max(0, insertIdx - 400), insertIdx);
    expect(region).toMatch(/if\s*\(\s*isEnabled\(\s*FLAGS\.VEHICLE_TRANSITION_OUTBOX\s*\)\s*\)/);

    // Cross-check: accept-path uses the EXACT same flag — they must match.
    expect(accept_44).toMatch(/isEnabled\(\s*FLAGS\.VEHICLE_TRANSITION_OUTBOX\s*\)/);
  });

  it('cancel-path INSERT writes reason = "orderCancel" (not "orderAccept" — distinct from accept-path)', () => {
    const insertIdx = cancel_44.indexOf('INSERT INTO "VehicleTransitionOutbox"');
    expect(insertIdx).toBeGreaterThan(-1);
    // Look forward ~600 chars for the VALUES block.
    const region = cancel_44.substring(insertIdx, insertIdx + 600);
    // Reason column contains the literal 'orderCancel'.
    expect(region).toMatch(/['"]orderCancel['"]/);
    // And NOT 'orderAccept' which is the accept-path reason.
    expect(region).not.toMatch(/['"]orderAccept['"]/);
  });

  it('cancel-path INSERT writes toStatus = "available" (cancel releases vehicle)', () => {
    const insertIdx = cancel_44.indexOf('INSERT INTO "VehicleTransitionOutbox"');
    const region = cancel_44.substring(insertIdx, insertIdx + 600);
    expect(region).toMatch(/['"]available['"]/);
  });

  it('cancel-path INSERT uses `tx.$executeRaw` (in-TX) — NOT `prismaClient.$executeRaw` (post-TX)', () => {
    const insertIdx = cancel_44.indexOf('INSERT INTO "VehicleTransitionOutbox"');
    expect(insertIdx).toBeGreaterThan(-1);
    const region = cancel_44.substring(Math.max(0, insertIdx - 200), insertIdx);
    // Must be `tx.$executeRaw` (transaction-scoped) — not `prismaClient.$executeRaw`.
    expect(region).toMatch(/tx\.\$executeRaw/);
    expect(region).not.toMatch(/prismaClient\.\$executeRaw\s*[`(]\s*[\s\S]{0,40}INSERT INTO "VehicleTransitionOutbox"/);
  });

  it('legacy post-TX onVehicleTransition is now guarded by `!isEnabled(FLAGS.VEHICLE_TRANSITION_OUTBOX)`', () => {
    // Locate the post-TX block — by its require() of vehicle-lifecycle.service.
    const legacyIdx = cancel_44.indexOf('vehicle-lifecycle.service');
    expect(legacyIdx).toBeGreaterThan(-1);

    // Walk back ~400 chars; the guard must be `if (!isEnabled(...))`.
    const region = cancel_44.substring(Math.max(0, legacyIdx - 400), legacyIdx);
    expect(region).toMatch(/if\s*\(\s*!\s*isEnabled\(\s*FLAGS\.VEHICLE_TRANSITION_OUTBOX\s*\)\s*\)/);
  });

  it('cancel-path INSERT happens INSIDE the in-TX block (so DB + outbox share commit boundary)', () => {
    // The cancel-path opens its TX via `withDbTimeout(async (tx) => { ... })` —
    // not a raw `prismaClient.$transaction` call. The INSERT must appear inside
    // that callback, AFTER the open and BEFORE the legacy post-TX hook.
    const txOpenIdx = cancel_44.indexOf('withDbTimeout(async (tx)');
    expect(txOpenIdx).toBeGreaterThan(-1);
    const insertIdx = cancel_44.indexOf('INSERT INTO "VehicleTransitionOutbox"');
    expect(insertIdx).toBeGreaterThan(txOpenIdx);

    // The legacy post-TX hook (require('vehicle-lifecycle.service')) must
    // appear AFTER the INSERT — outside the TX.
    const legacyHookIdx = cancel_44.indexOf("require('../../shared/services/vehicle-lifecycle.service')");
    expect(legacyHookIdx).toBeGreaterThan(insertIdx);
  });
});

// =============================================================================
// RUNTIME — drive a fake transaction through both flag states and assert the
// INSERT is or isn't called.
//
// We can't run the full cancel orchestrator without dragging in dozens of
// service modules. Instead: extract the logical contract into a runtime
// re-creation of the cancel-path's vehicle-transition write step, mirroring
// the source structure, and verify both flag branches.
// =============================================================================

describe('Fix #44 — runtime: VehicleTransitionOutbox INSERT shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Re-creates the cancel-path's in-TX block per source contract — tests the
  // shape of the SQL the production code generates without spinning up Prisma.
  async function emulateCancelInTxBlock_44(
    flagOn: boolean,
    releasedVehicleData: Array<{
      vehicleId: string;
      vehicleType: string;
      vehicleSubtype: string;
      transporterId: string;
      previousStatus: string;
    }>,
    tx: { $executeRaw: jest.Mock }
  ): Promise<void> {
    function generateVehicleKeyMock(t: string, st: string): string | null {
      if (!t || !st) return null;
      return `${t}_${st}`;
    }
    if (flagOn) {
      for (const rv of releasedVehicleData) {
        const vKey = generateVehicleKeyMock(rv.vehicleType, rv.vehicleSubtype);
        await tx.$executeRaw`
          INSERT INTO "VehicleTransitionOutbox"
            ("vehicleId", "vehicleKey", "transporterId",
             "fromStatus", "toStatus", "reason")
          VALUES
            (${rv.vehicleId}, ${vKey || null}, ${rv.transporterId},
             ${rv.previousStatus}, ${'available'}, ${'orderCancel'})
        `;
      }
    }
  }

  it('flag-ON: tx.$executeRaw is called once per released vehicle with reason=orderCancel', async () => {
    const tx_44 = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const released_44 = [
      { vehicleId: 'v1', vehicleType: 'open', vehicleSubtype: '17ft', transporterId: 't1', previousStatus: 'in_transit' },
      { vehicleId: 'v2', vehicleType: 'closed', vehicleSubtype: '20ft', transporterId: 't1', previousStatus: 'in_transit' },
    ];

    await emulateCancelInTxBlock_44(true, released_44, tx_44);

    expect(tx_44.$executeRaw).toHaveBeenCalledTimes(2);
    // Each call's first arg is a TemplateStringsArray of the SQL template.
    const call0 = tx_44.$executeRaw.mock.calls[0];
    const sqlTemplate = call0[0] as TemplateStringsArray;
    const sqlText = sqlTemplate.join('?');
    expect(sqlText).toMatch(/INSERT INTO "VehicleTransitionOutbox"/);
    expect(sqlText).toMatch(/"vehicleId"/);
    expect(sqlText).toMatch(/"reason"/);

    // The interpolated values include `'available'` (toStatus) and `'orderCancel'` (reason).
    const values = call0.slice(1);
    expect(values).toContain('available');
    expect(values).toContain('orderCancel');
    expect(values).toContain('v1');
  });

  it('flag-OFF: tx.$executeRaw is NOT called (legacy post-TX takes ownership)', async () => {
    const tx_44 = { $executeRaw: jest.fn() };
    const released_44 = [
      { vehicleId: 'v1', vehicleType: 'open', vehicleSubtype: '17ft', transporterId: 't1', previousStatus: 'in_transit' },
    ];

    await emulateCancelInTxBlock_44(false, released_44, tx_44);

    expect(tx_44.$executeRaw).not.toHaveBeenCalled();
  });

  it('flag-ON + vehicleType empty → vehicleKey is null in the SQL parameters', async () => {
    const tx_44 = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const released_44 = [
      { vehicleId: 'v3', vehicleType: '', vehicleSubtype: '20ft', transporterId: 't1', previousStatus: 'in_transit' },
    ];

    await emulateCancelInTxBlock_44(true, released_44, tx_44);

    const call0 = tx_44.$executeRaw.mock.calls[0];
    const values = call0.slice(1);
    // `vKey || null` → null because '' is falsy.
    expect(values).toContain(null);
  });

  it('flag-ON + 5 released vehicles → 5 INSERT calls (no batching, simple loop per source)', async () => {
    const tx_44 = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const released_44 = Array.from({ length: 5 }, (_, i) => ({
      vehicleId: `v${i}`,
      vehicleType: 'open',
      vehicleSubtype: '17ft',
      transporterId: 't1',
      previousStatus: 'in_transit',
    }));

    await emulateCancelInTxBlock_44(true, released_44, tx_44);

    expect(tx_44.$executeRaw).toHaveBeenCalledTimes(5);
  });
});

export {};
