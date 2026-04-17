/**
 * =============================================================================
 * F-B-76 — Broadcast KYC check fails CLOSED on DB error with retry backoff
 * =============================================================================
 *
 * Verifies the fail-closed contract introduced by F-B-76 in
 * `order-broadcast.service.ts`:
 *
 *   - The KYC findMany call is wrapped in a retry loop (3 attempts) with
 *     exponential backoff (100ms -> 200ms -> 400ms) to absorb transient DB
 *     errors (connection pool contention, brief network blips, rolling
 *     restart).
 *   - On terminal failure (all retries exhausted), `verifiedTransporters`
 *     is set to `[]` (fail-CLOSED). A skipped broadcast is strictly safer
 *     than leaking an assignment opportunity to an un-KYC'd driver.
 *   - The legacy "Fail-open: proceed with current list" comment is gone
 *     — it represented the defeated anti-pattern.
 *   - Observability wires are in place:
 *       * `broadcast_kyc_failclosed_total` counter increments on fail-closed
 *       * A loud error log reaches the CloudWatch page-filter via the phrase
 *         `DISPATCH DEGRADED`
 *
 * Pattern reference:
 *   - Stripe Connect identity verification outage doctrine
 *     https://stripe.com/docs/connect/identity-verification
 *   - AWS security blog "fail closed when identity check unavailable"
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const BROADCAST_SERVICE = path.resolve(
  __dirname,
  '../modules/order/order-broadcast.service.ts'
);

describe('F-B-76: broadcast KYC check is fail-closed with retry+backoff', () => {
  const source = fs.readFileSync(BROADCAST_SERVICE, 'utf-8');

  test('retry loop caps at 3 attempts via F_B_76_MAX_ATTEMPTS = 3', () => {
    expect(source).toContain('F_B_76_MAX_ATTEMPTS = 3');
  });

  test('retry loop uses exponential backoff with 100ms base', () => {
    expect(source).toContain('F_B_76_BASE_BACKOFF_MS = 100');
    expect(source).toContain('Math.pow(2, kycAttempt - 1)');
  });

  test('retry loop awaits the backoff via setTimeout before the next attempt', () => {
    // Required so the DB gets real recovery time before we retry.
    expect(source).toContain(
      'await new Promise(resolve => setTimeout(resolve, backoff))'
    );
  });

  test('each retry attempt logs attempt N of MAX with the error', () => {
    expect(source).toContain(
      'KYC check attempt ${kycAttempt}/${F_B_76_MAX_ATTEMPTS}'
    );
  });

  test('on terminal failure, verifiedTransporters is set to empty array (fail-CLOSED)', () => {
    // The fail-closed block must zero out the pool so no un-KYC'd driver
    // can receive this broadcast.
    expect(source).toMatch(/if\s*\(\s*!kycSucceeded\s*\)\s*{[\s\S]*?verifiedTransporters = \[\];/);
  });

  test('fail-closed block increments broadcast_kyc_failclosed_total counter', () => {
    expect(source).toContain("'broadcast_kyc_failclosed_total'");
    expect(source).toContain('metrics.incrementCounter(');
  });

  test('fail-closed block logs a DISPATCH DEGRADED error for ops alerting', () => {
    // CloudWatch log filter keys on this exact phrase to page on-call.
    expect(source).toContain('DISPATCH DEGRADED');
    expect(source).toContain('KYC gate FAIL CLOSED for order');
  });

  test('legacy "Fail-open: proceed with current list" comment is gone', () => {
    // The old anti-pattern comment must not linger — it would mislead
    // future maintainers about the module's safety posture.
    expect(source).not.toContain('Fail-open: if KYC check fails, proceed with current list');
    expect(source).not.toContain('proceeding with current list');
  });

  test('retry catch branch captures the error without fail-opening', () => {
    // Inside the retry loop, the catch must EITHER schedule a retry OR fall
    // through to the fail-closed block. It must not assign
    // verifiedTransporters to matchingTransporters (the old fail-open).
    const retryBlockMatch = source.match(/while\s*\(\s*kycAttempt\s*<\s*F_B_76_MAX_ATTEMPTS[\s\S]*?^\s*}/m);
    expect(retryBlockMatch).not.toBeNull();
    const retryBlock = retryBlockMatch?.[0] ?? '';
    // In the retry block, we must not see a silent fallback to the full pool.
    expect(retryBlock).not.toContain('verifiedTransporters = matchingTransporters');
  });

  test('the F-B-75 KYC findMany filter is preserved inside the retry loop', () => {
    // We must not lose the F-B-75 filter when wrapping in retries.
    expect(source).toContain("kycStatus: 'VERIFIED'");
    expect(source).toContain('isVerified: true');
    expect(source).toContain('isActive: true');
  });

  test('landmark comment documents Stripe/AWS fail-closed doctrine', () => {
    // Archaeology: future maintainers must know this is a deliberate
    // fail-closed choice, not a regression.
    expect(source).toContain('F-B-76: fail CLOSED on KYC check failure');
    expect(source).toContain('Stripe / AWS "fail-closed on identity verification outage"');
  });
});
