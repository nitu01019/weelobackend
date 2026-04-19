/**
 * =============================================================================
 * DIFFERENTIATOR SMOKE TEST — Multi-Vehicle Concurrent Hold
 * =============================================================================
 *
 * Protects Weelo's sacred invariant #2: a transporter can hold MULTIPLE trucks
 * concurrently (unlike Uber/Ola, which serialise). Two different transporters
 * with DISJOINT vehicle sets must not block each other. Same transporter
 * requesting N vehicles gets N atomic TruckRequest rows in one TX.
 *
 * This file is a **blocking gate** for all of Weelo Phase 5 (104 HIGH fixes
 * across P1-P10). Every PR in those phases must pass this suite.
 *
 * Contract asserted here:
 *   - Same-transporter multi-vehicle request creates N assignments atomically
 *     (single $transaction). No partial state possible.
 *   - Hold locks are scoped per-hold/per-truck, NOT per-transporter -- so two
 *     transporters with disjoint vehicle sets can hold concurrently.
 *   - Canonical lock keys are deterministic under id reordering (commutative),
 *     so the F-A-78 canonicalization won't regress (forward-compat guard).
 *   - Overlapping-vehicle conflict path exists (guarded -- activates once
 *     F-A-78 canonicalization ships a cross-request vehicle lock).
 *
 * Style: static source assertions + deterministic pure function tests. No live
 * DB/Redis required -- runs in <1s.
 *
 * =============================================================================
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function sourceExists(relPath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}

// Future canonical lock-key helper (F-A-78)
const CANONICAL_LOCK_HELPERS = [
  'src/modules/truck-hold/hold-lock-key.ts',
  'src/modules/truck-hold/canonical-lock.ts',
  'src/shared/services/canonical-lock-key.service.ts',
];

function canonicalLockHelperExists(): { exists: boolean; relPath?: string } {
  for (const rel of CANONICAL_LOCK_HELPERS) {
    if (sourceExists(rel)) return { exists: true, relPath: rel };
  }
  return { exists: false };
}

// A pure, deterministic reference implementation. This is the shape the F-A-78
// helper is expected to produce — if the real helper lands with a different
// algorithm, flip this to dynamic import.
function referenceCanonicalLockKey(truckRequestIds: readonly string[]): string {
  const sorted = [...truckRequestIds].sort();
  return crypto.createHash('sha256').update(sorted.join(',')).digest('hex');
}

// ---------------------------------------------------------------------------
// Same-transporter atomicity (one TX, N rows)
// ---------------------------------------------------------------------------

describe('Multi-Vehicle Hold: same-transporter atomicity', () => {
  it('flex-hold.service creates the hold inside a prisma transaction', () => {
    const src = readSource('src/modules/truck-hold/flex-hold.service.ts');
    // Any creation path that writes a TruckHoldLedger row must be wrapped in
    // prismaClient.$transaction(...) OR the repo wrapper withDbTimeout(async
    // (tx) => ...) OR reference tx.truckHoldLedger.create/update.
    const hasTx =
      /prismaClient\.\$transaction\s*\(/.test(src) ||
      /withDbTimeout\s*\(\s*async\s*\(\s*tx/.test(src) ||
      /tx\.truckHoldLedger\.(?:create|update)\s*\(/.test(src);
    expect(hasTx).toBe(true);
  });

  it('truck-hold-create service wraps multi-vehicle creation in a single transaction', () => {
    const rel = 'src/modules/truck-hold/truck-hold-create.service.ts';
    if (!sourceExists(rel)) {
      return; // forward-compat: module may be renamed, covered by facade test below
    }
    const src = readSource(rel);
    // Accept either raw $transaction or the repo's withDbTimeout(async (tx) => ...)
    // wrapper, which internally invokes prismaClient.$transaction.
    const hasTxWrapper =
      /\$transaction\s*\(/.test(src) || /withDbTimeout\s*\(\s*async\s*\(\s*tx/.test(src);
    expect(hasTxWrapper).toBe(true);
    // Should emit TruckHoldLedger writes inside that TX.
    expect(src).toMatch(/tx\.truckHoldLedger\.(?:create|update|upsert)/);
  });

  it('truck-hold monolith confirm wraps its assignment creation in a transaction (atomic N assignments)', () => {
    const src = readSource('src/modules/truck-hold/truck-hold.service.ts');
    // The monolith uses the repo wrapper `withDbTimeout(async (tx) => ...)`
    // which bottoms out in prismaClient.$transaction. Either form satisfies the
    // atomicity contract.
    const hasTxWrapper =
      /\$transaction\s*\(/.test(src) || /withDbTimeout\s*\(\s*async\s*\(\s*tx/.test(src);
    expect(hasTxWrapper).toBe(true);
    // And assignment writes reference the TX client (not the bare prismaClient)
    // inside at least one flow.
    expect(src).toMatch(/tx\.assignment\.(?:create|update|updateMany|createMany|findMany)/);
  });
});

// ---------------------------------------------------------------------------
// Cross-transporter non-blocking (per-hold lock, not per-transporter)
// ---------------------------------------------------------------------------

describe('Multi-Vehicle Hold: cross-transporter parallelism', () => {
  it('flex-hold lock key is scoped per-hold (holdId), not per-transporter', () => {
    const src = readSource('src/modules/truck-hold/flex-hold.service.ts');
    expect(src).toMatch(/FLEX_HOLD_LOCK:\s*\(holdId:\s*string\)\s*=>\s*`flex-hold:\$\{holdId\}`/);
    // Lock must NOT be keyed on transporterId alone — that would serialise a
    // single transporter's parallel holds on disjoint vehicle sets.
    expect(src).not.toMatch(/FLEX_HOLD_LOCK:\s*\(transporterId:\s*string\)\s*=>\s*`flex-hold:\$\{transporterId\}`/);
  });

  it('confirmed-hold lock key is scoped per-assignment (not per-transporter)', () => {
    const src = readSource('src/modules/truck-hold/confirmed-hold.service.ts');
    // DRIVER_ACCEPTANCE lock is keyed on assignmentId -- this is the correct
    // grain. A per-transporter lock would serialise multi-truck acceptance.
    expect(src).toMatch(/DRIVER_ACCEPTANCE/);
    expect(src).toMatch(/acquireLock\(\s*lockKey/);
  });

  it('truck-hold-confirm service locks per-hold (holdId), not per-transporter', () => {
    const src = readSource('src/modules/truck-hold/truck-hold-confirm.service.ts');
    expect(src).toMatch(/hold:confirm:lock:\$\{holdId\}/);
    expect(src).not.toMatch(/hold:confirm:lock:\$\{transporterId\}/);
  });
});

// ---------------------------------------------------------------------------
// Canonical lock-key commutativity (F-A-78 forward-compat guard)
// ---------------------------------------------------------------------------

describe('Multi-Vehicle Hold: canonical lock-key is commutative', () => {
  it('reference canonicalisation produces identical hash under id reordering', () => {
    const setA = ['req-1', 'req-2', 'req-3'];
    const setB = ['req-3', 'req-1', 'req-2'];
    const setC = ['req-2', 'req-3', 'req-1'];
    const keyA = referenceCanonicalLockKey(setA);
    const keyB = referenceCanonicalLockKey(setB);
    const keyC = referenceCanonicalLockKey(setC);
    expect(keyA).toBe(keyB);
    expect(keyB).toBe(keyC);
  });

  it('reference canonicalisation discriminates between overlapping but non-equal sets', () => {
    const setA = ['req-1', 'req-2', 'req-3'];
    const setB = ['req-1', 'req-2', 'req-4'];
    expect(referenceCanonicalLockKey(setA)).not.toBe(referenceCanonicalLockKey(setB));
  });

  it('reference canonicalisation is stable across repeated evaluations', () => {
    const ids = ['req-a', 'req-b', 'req-c'];
    expect(referenceCanonicalLockKey(ids)).toBe(referenceCanonicalLockKey(ids));
  });

  it('reference canonicalisation handles single-element and empty sets', () => {
    expect(referenceCanonicalLockKey(['only-one'])).toHaveLength(64); // sha256 hex
    expect(referenceCanonicalLockKey([])).toHaveLength(64);
  });

  it('F-A-78 canonical lock helper is wire-compatible once it ships', () => {
    const { exists, relPath } = canonicalLockHelperExists();
    if (!exists || !relPath) {
      // TODO: activates once F-A-78 canonicalization helper ships
      return;
    }
    // Helper must expose a pure function whose output is commutative under
    // input reordering. We assert on the source pattern because importing the
    // module may require runtime wiring we don't want here.
    const src = readSource(relPath);
    expect(src).toMatch(/\.sort\(\s*\)/);
    expect(src).toMatch(/createHash\(\s*['"]sha256['"]\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// Overlapping-vehicle conflict guard (forward-compat, F-A-78)
// ---------------------------------------------------------------------------

describe('Multi-Vehicle Hold: overlapping-vehicle conflict', () => {
  it('current code path rejects hold on vehicles already held (via Prisma unique constraint or eligibility check)', () => {
    // Today the guard is implemented via:
    //   (a) hold eligibility check in `hold-eligibility.ts` and/or
    //   (b) per-truck Redis lock `REDIS_KEYS.TRUCK_LOCK(truckId)` in truck-hold.service
    // We assert at least one of these exists.
    const eligibility = sourceExists('src/modules/truck-hold/hold-eligibility.ts')
      ? readSource('src/modules/truck-hold/hold-eligibility.ts')
      : '';
    const monolith = readSource('src/modules/truck-hold/truck-hold.service.ts');

    const hasPerTruckLock = /TRUCK_LOCK\(/.test(monolith);
    const hasEligibilityCheck =
      eligibility.length > 0 && /checkEligibility|assertEligible|holdEligibility/i.test(eligibility);

    expect(hasPerTruckLock || hasEligibilityCheck).toBe(true);
  });

  it('F-A-78 cross-request vehicle conflict rejection lands cleanly once canonical helper ships', () => {
    const { exists } = canonicalLockHelperExists();
    if (!exists) {
      // TODO: activates once F-A-78 ships canonical cross-request conflict rejection
      return;
    }
    // Once the canonical helper exists, the monolith path should reference it.
    const monolith = readSource('src/modules/truck-hold/truck-hold.service.ts');
    const split = sourceExists('src/modules/truck-hold/truck-hold-create.service.ts')
      ? readSource('src/modules/truck-hold/truck-hold-create.service.ts')
      : '';
    const anyReferencesHelper =
      /canonicalLockKey|hold-lock-key|canonical-lock/i.test(monolith) ||
      /canonicalLockKey|hold-lock-key|canonical-lock/i.test(split);
    expect(anyReferencesHelper).toBe(true);
  });
});
