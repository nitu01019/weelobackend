/**
 * =============================================================================
 * F-A-75: KYC SECOND-GATE — row-locked eligibility re-check inside hold TX
 * =============================================================================
 *
 * Pattern: KYC FSM (Fernando Hermida + Ola in-ride re-check + Uber Rider Identity)
 *
 * Why a second gate? The broadcast-time KYC filter (F-B-75 in order-broadcast.service)
 * is a point-in-time snapshot. Between broadcast and hold/accept, an admin may flip
 * isActive=false or revoke kycStatus. Without a second gate inside the hold transaction,
 * an already-dispatched transporter/driver can complete a privileged action after being
 * de-verified — a regulator-visible compliance bug.
 *
 * Why row-lock (SELECT ... FOR UPDATE)? Without the lock, a concurrent admin UPDATE that
 * flips kycStatus→REJECTED can interleave between our read and the subsequent hold
 * mutation, leaving us holding a truck for a user who is no longer eligible. The row
 * lock serializes the KYC verdict with the hold write inside a single transaction.
 *
 * Prisma has no native FOR UPDATE API; we use $queryRaw with parametrized SQL inside
 * the caller's transaction client. On any failure the caller's transaction rolls back,
 * leaving no partial hold state.
 *
 * Extracted into its own module so unit tests that jest.mock('truck-hold.service')
 * do not accidentally erase the helper/error class from cross-module imports.
 */

import type { Prisma } from '@prisma/client';
import { metrics } from '../../shared/monitoring/metrics.service';

export type EligibilityStage =
  | 'flex_hold'
  | 'confirmed_hold'
  | 'legacy_hold'
  | 'legacy_accept'
  | 'driver_accept';

export class HoldEligibilityError extends Error {
  public readonly code: string;
  public readonly userId: string;
  constructor(code: string, userId: string, message: string) {
    super(message);
    this.name = 'HoldEligibilityError';
    this.code = code;
    this.userId = userId;
  }
}

export async function validateActorEligibility(
  tx: Prisma.TransactionClient,
  userId: string,
  stage: EligibilityStage
): Promise<void> {
  if (!userId) {
    throw new HoldEligibilityError('USER_ID_MISSING', userId || '', 'User id is required for eligibility check');
  }

  const rows = await tx.$queryRaw<Array<{ isActive: boolean; kycStatus: string }>>`
    SELECT "isActive", "kycStatus"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE
  `;
  const actor = rows[0];

  if (!actor) {
    metrics.incrementCounter('hold_ineligible_reject_total', { stage, reason: 'user_not_found' });
    throw new HoldEligibilityError('USER_NOT_FOUND', userId, `User ${userId} not found`);
  }
  if (!actor.isActive) {
    metrics.incrementCounter('hold_ineligible_reject_total', { stage, reason: 'inactive' });
    throw new HoldEligibilityError('USER_INACTIVE', userId, `User ${userId} is not active`);
  }
  if (actor.kycStatus !== 'VERIFIED') {
    metrics.incrementCounter('hold_ineligible_reject_total', { stage, reason: 'kyc_missing' });
    throw new HoldEligibilityError('FORBIDDEN_INELIGIBLE', userId, `User ${userId} KYC not VERIFIED (status: ${actor.kycStatus})`);
  }
}
