/**
 * =============================================================================
 * F-A-75 — KYC second-gate inside hold transaction with row-lock
 * =============================================================================
 *
 * Verifies the defense-in-depth KYC + isActive re-check introduced by F-A-75
 * across the hold transaction surface. The broadcast-time filter (F-B-75) is a
 * snapshot; between broadcast and hold/accept, an admin may flip isActive=false
 * or revoke kycStatus. Without a second gate inside each hold transaction, an
 * already-dispatched transporter/driver can complete a privileged action after
 * being de-verified — a regulator-visible compliance bug.
 *
 * Pattern reference:
 *   - Fernando Hermida — KYC as FSM
 *     https://www.fernandohermida.com/posts/simplifying-customer-onboarding-with-finite-state-machines
 *   - Uber Rider Identity / Real-Time Document Check
 *     https://www.uber.com/blog/ubers-real-time-document-check/
 *   - Ola in-ride KYC three-gate defense
 *     https://blog.olacabs.com/verify-your-document-in-your-ride-to-continue-using-ola-money/
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const TRUCK_HOLD_SERVICE = path.resolve(
  __dirname,
  '../modules/truck-hold/truck-hold.service.ts'
);
const FLEX_HOLD_SERVICE = path.resolve(
  __dirname,
  '../modules/truck-hold/flex-hold.service.ts'
);
const CONFIRMED_HOLD_SERVICE = path.resolve(
  __dirname,
  '../modules/truck-hold/confirmed-hold.service.ts'
);
const HOLD_ELIGIBILITY_MODULE = path.resolve(
  __dirname,
  '../modules/truck-hold/hold-eligibility.ts'
);

describe('F-A-75: validateActorEligibility helper exists and is row-locked', () => {
  // Helper lives in its own module so unit tests that jest.mock('truck-hold.service')
  // cannot erase the class from cross-module imports in flex-hold/confirmed-hold.
  const source = fs.readFileSync(HOLD_ELIGIBILITY_MODULE, 'utf-8');

  test('exports validateActorEligibility helper accepting (tx, userId, stage)', () => {
    expect(source).toContain('export async function validateActorEligibility');
    expect(source).toMatch(/tx:\s*Prisma\.TransactionClient/);
    expect(source).toMatch(/userId:\s*string/);
  });

  test('helper uses SELECT ... FOR UPDATE row-lock (not a plain findUnique)', () => {
    // SOLUTION.md F-A-75: pattern class is "KYC FSM + row-locked SELECT FOR UPDATE".
    // A plain findUnique/findFirst read has no row lock and races with admin revoke.
    expect(source).toContain('FOR UPDATE');
    expect(source).toMatch(/tx\.\$queryRaw<[^>]*isActive[^>]*kycStatus[^>]*>/);
    expect(source).toMatch(/FROM\s+"User"\s+WHERE\s+"id"\s*=\s*\$\{userId\}/i);
  });

  test('helper throws HoldEligibilityError with discrete codes per failure reason', () => {
    expect(source).toContain('export class HoldEligibilityError');
    expect(source).toContain("'USER_NOT_FOUND'");
    expect(source).toContain("'USER_INACTIVE'");
    expect(source).toContain("'FORBIDDEN_INELIGIBLE'");
  });

  test('helper requires kycStatus === VERIFIED (not a boolean, not isVerified legacy)', () => {
    // F-B-75 established kycStatus as the single source of truth; the legacy
    // isVerified boolean is retained only for defense-in-depth in the broadcast
    // filter. The hold-path second-gate must use the enum verdict directly.
    expect(source).toContain("actor.kycStatus !== 'VERIFIED'");
  });

  test('helper increments hold_ineligible_reject_total counter with stage + reason labels', () => {
    expect(source).toContain("'hold_ineligible_reject_total'");
    expect(source).toMatch(/stage[^,]*,\s*reason:\s*'(?:user_not_found|inactive|kyc_missing)'/);
  });
});

describe('F-A-75: helper is called from every privileged hold call-site', () => {
  const monolithSource = fs.readFileSync(TRUCK_HOLD_SERVICE, 'utf-8');
  const flexSource = fs.readFileSync(FLEX_HOLD_SERVICE, 'utf-8');
  const confirmedSource = fs.readFileSync(CONFIRMED_HOLD_SERVICE, 'utf-8');

  test('legacy holdTrucks calls validateActorEligibility inside withDbTimeout TX', () => {
    // The call must be INSIDE the TX callback (tx scope), not outside, otherwise
    // the FOR UPDATE lock does not apply to the hold mutation.
    const holdTrucksSection = monolithSource.slice(
      monolithSource.indexOf('async holdTrucks('),
      monolithSource.indexOf('async confirmHold(')
    );
    expect(holdTrucksSection).toContain('await withDbTimeout(async (tx) => {');
    expect(holdTrucksSection).toMatch(
      /await\s+withDbTimeout\(async\s*\(tx\)\s*=>\s*{[\s\S]*?validateActorEligibility\(tx,\s*transporterId,\s*'legacy_hold'\)/
    );
  });

  test('legacy confirmHoldWithAssignments calls validateActorEligibility inside its TX', () => {
    const confirmSection = monolithSource.slice(
      monolithSource.indexOf('async confirmHoldWithAssignments('),
      monolithSource.indexOf('async releaseHold(')
    );
    expect(confirmSection).toMatch(
      /validateActorEligibility\(tx,\s*transporterId,\s*'legacy_accept'\)/
    );
  });

  test('createFlexHold wraps truckHoldLedger.create in $transaction and calls helper', () => {
    const createSection = flexSource.slice(
      flexSource.indexOf('async createFlexHold('),
      flexSource.indexOf('async extendFlexHold(')
    );
    expect(createSection).toContain('prismaClient.$transaction(async (tx)');
    expect(createSection).toMatch(
      /validateActorEligibility\(tx,\s*request\.transporterId,\s*'flex_hold'\)/
    );
    // The helper call must be BEFORE the ledger.create so ineligible actors never
    // leave a ledger row behind.
    expect(createSection.indexOf('validateActorEligibility'))
      .toBeLessThan(createSection.indexOf('tx.truckHoldLedger.create'));
  });

  test('initializeConfirmedHold calls helper inside its existing FOR UPDATE TX', () => {
    const initSection = confirmedSource.slice(
      confirmedSource.indexOf('async initializeConfirmedHold('),
      confirmedSource.indexOf('async cacheConfirmedHoldState(')
    );
    expect(initSection).toMatch(
      /validateActorEligibility\(tx,\s*transporterId,\s*'confirmed_hold'\)/
    );
    // Call must run BEFORE the hold-row FOR UPDATE read, so the user-row lock is
    // taken in the lock-order "User then TruckHoldLedger" across all call-sites.
    expect(initSection.indexOf('validateActorEligibility'))
      .toBeLessThan(initSection.indexOf('FROM "TruckHoldLedger"'));
  });

  test('handleDriverAcceptance wraps CAS update in $transaction and calls helper with driverId', () => {
    const acceptSection = confirmedSource.slice(
      confirmedSource.indexOf('async handleDriverAcceptance('),
      confirmedSource.indexOf('async handleDriverDecline(')
    );
    expect(acceptSection).toContain('prismaClient.$transaction(async (tx)');
    expect(acceptSection).toMatch(
      /validateActorEligibility\(tx,\s*driverId,\s*'driver_accept'\)/
    );
    // Helper must run BEFORE the assignment CAS update so we never mark an
    // un-KYC'd driver as driver_accepted.
    expect(acceptSection.indexOf('validateActorEligibility'))
      .toBeLessThan(acceptSection.indexOf('tx.assignment.updateMany'));
  });
});

describe('F-A-75: eligibility errors surface with 403 semantics, not generic 500', () => {
  const monolithSource = fs.readFileSync(TRUCK_HOLD_SERVICE, 'utf-8');
  const flexSource = fs.readFileSync(FLEX_HOLD_SERVICE, 'utf-8');
  const confirmedSource = fs.readFileSync(CONFIRMED_HOLD_SERVICE, 'utf-8');

  test('holdTrucks catch block maps HoldEligibilityError to 403 response with error code', () => {
    const holdTrucksSection = monolithSource.slice(
      monolithSource.indexOf('async holdTrucks('),
      monolithSource.indexOf('async confirmHold(')
    );
    expect(holdTrucksSection).toContain('error instanceof HoldEligibilityError');
    expect(holdTrucksSection).toMatch(/statusCode\s*=\s*403/);
  });

  test('confirmHoldWithAssignments catch returns HoldEligibilityError message verbatim', () => {
    const confirmSection = monolithSource.slice(
      monolithSource.indexOf('async confirmHoldWithAssignments('),
      monolithSource.indexOf('async releaseHold(')
    );
    expect(confirmSection).toContain('error instanceof HoldEligibilityError');
  });

  test('createFlexHold catch maps HoldEligibilityError to structured {success:false,error}', () => {
    expect(flexSource).toContain('error instanceof HoldEligibilityError');
    expect(flexSource).toContain("'[FLEX HOLD] Eligibility denied'");
  });

  test('initializeConfirmedHold catch returns httpStatus 403 on HoldEligibilityError', () => {
    const initSection = confirmedSource.slice(
      confirmedSource.indexOf('async initializeConfirmedHold('),
      confirmedSource.indexOf('async cacheConfirmedHoldState(')
    );
    expect(initSection).toContain('error instanceof HoldEligibilityError');
    expect(initSection).toMatch(/httpStatus:\s*403/);
  });

  test('handleDriverAcceptance catch surfaces driver eligibility failures distinctly', () => {
    const acceptSection = confirmedSource.slice(
      confirmedSource.indexOf('async handleDriverAcceptance('),
      confirmedSource.indexOf('async handleDriverDecline(')
    );
    expect(acceptSection).toContain('error instanceof HoldEligibilityError');
    expect(acceptSection).toContain('Driver eligibility denied on accept');
  });
});

describe('F-A-75: industry-pattern comments present for future reviewers', () => {
  const eligibilitySource = fs.readFileSync(HOLD_ELIGIBILITY_MODULE, 'utf-8');

  test('module documents KYC FSM pattern and row-lock rationale', () => {
    expect(eligibilitySource).toContain('F-A-75: KYC SECOND-GATE');
    // Rationale must explain WHY a second gate is needed — i.e. that broadcast
    // is a point-in-time snapshot and an admin can flip kycStatus mid-flight.
    expect(eligibilitySource).toMatch(/point-in-time snapshot|concurrent admin/i);
    // The row-lock rationale must be present so a future reviewer does not
    // "optimize" FOR UPDATE back into a plain findUnique.
    expect(eligibilitySource).toMatch(/row.*lock|FOR UPDATE/i);
  });

  test('truck-hold.service re-exports helper for backward-compat consumers', () => {
    const monolithSource = fs.readFileSync(TRUCK_HOLD_SERVICE, 'utf-8');
    expect(monolithSource).toContain("export { validateActorEligibility, HoldEligibilityError } from './hold-eligibility'");
  });
});
