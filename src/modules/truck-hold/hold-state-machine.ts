/**
 * =============================================================================
 * HOLD STATE MACHINE — FLEX→CONFIRMED phase CAS guard (F-A-79)
 * =============================================================================
 *
 * ⚠ PRE-SHIP CHECKLIST (F-A-79 — differentiator-critical)
 *
 * This file centralises the two-phase hold (FLEX → CONFIRMED) transition —
 * a Weelo differentiator. Any edit REQUIRES:
 *
 *   1. `src/__tests__/hold-phase-cas-monolith.test.ts` GREEN.
 *   2. `npm run test:differentiator` GREEN (30/30 including the
 *      now-active forward-compat check in `two-phase-hold-fsm.test.ts`).
 *   3. Second reviewer sign-off before any deploy.
 *
 * M-009 backfill (`migrations/M-009-hold-phase-backfill.sql`) is IRREVERSIBLE.
 * Run AFTER `FF_HOLD_GUARDED_TRANSITIONS=ON` + 1-release soak in production.
 * See `.planning/phase4/INDEX.md` § F-A-79 and Part 7 pre-ship checklist.
 *
 * CONTRACT
 * --------
 * HoldPhase is the canonical string enum produced by Prisma
 * (FLEX, CONFIRMED, EXPIRED, RELEASED). Valid transitions:
 *
 *   FLEX       → { CONFIRMED, EXPIRED, RELEASED }
 *   CONFIRMED  → { RELEASED, EXPIRED }
 *   EXPIRED    → {}   (terminal)
 *   RELEASED   → {}   (terminal)
 *
 * Any attempt to leave a terminal state, or to downgrade CONFIRMED → FLEX,
 * throws `HoldTransitionError`.
 *
 * USAGE
 * -----
 *   - `assertHoldPhaseTransition(from, to)` — pure FSM predicate check.
 *   - `guardedConfirmFlexToConfirmed(tx, holdId, patch)` — atomic
 *     updateMany with `WHERE phase='FLEX' AND status='active'`. Returns
 *     `{ updated, rowsAffected }` so callers can distinguish a real flip
 *     from a CAS-miss (already confirmed, expired, released) without
 *     exceptions.
 *
 * The helper is exported but NOT wired into any confirm path under this PR.
 * Wiring happens in F-A-80 saga extraction (Wave 2) behind
 * `FF_HOLD_GUARDED_TRANSITIONS` + `FF_CONFIRM_SAGA_V2_*` flags.
 * =============================================================================
 */

import type { Prisma } from '@prisma/client';
import { HoldPhase } from '../../shared/database/prisma.service';

// ---------------------------------------------------------------------------
// FSM transition table — frozen, single source of truth
// ---------------------------------------------------------------------------

export const HOLD_VALID_TRANSITIONS: Readonly<
  Record<HoldPhase, readonly HoldPhase[]>
> = Object.freeze({
  [HoldPhase.FLEX]: Object.freeze([
    HoldPhase.CONFIRMED,
    HoldPhase.EXPIRED,
    HoldPhase.RELEASED,
  ]) as readonly HoldPhase[],
  [HoldPhase.CONFIRMED]: Object.freeze([
    HoldPhase.RELEASED,
    HoldPhase.EXPIRED,
  ]) as readonly HoldPhase[],
  [HoldPhase.EXPIRED]: Object.freeze([]) as readonly HoldPhase[],
  [HoldPhase.RELEASED]: Object.freeze([]) as readonly HoldPhase[],
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HoldTransitionError extends Error {
  public readonly from: HoldPhase;
  public readonly to: HoldPhase;
  public readonly reason: string;

  constructor(from: HoldPhase, to: HoldPhase, reason: string = 'not in VALID_TRANSITIONS table') {
    super(`Invalid hold phase transition: ${from} -> ${to} (${reason})`);
    this.name = 'HoldTransitionError';
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Pure FSM guard
// ---------------------------------------------------------------------------

/**
 * Throw {@link HoldTransitionError} if `from -> to` is not a legal hold-phase
 * transition. Callers should invoke this before any write that changes
 * `phase` so the invalid edge never reaches the database.
 */
export function assertHoldPhaseTransition(from: HoldPhase, to: HoldPhase): void {
  const allowed = HOLD_VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HoldTransitionError(from, to);
  }
}

// ---------------------------------------------------------------------------
// Guarded write — CAS-backed FLEX → CONFIRMED update
// ---------------------------------------------------------------------------

export interface GuardedConfirmPatch {
  /** Phase-2 expiry time — max `CONFIRMED_HOLD_MAX_SECONDS` from confirm. */
  confirmedExpiresAt: Date;
  /** Override confirmedAt timestamp (defaults to `new Date()`). */
  confirmedAt?: Date;
  /** Override phaseChangedAt timestamp (defaults to `new Date()`). */
  phaseChangedAt?: Date;
}

export interface GuardedConfirmResult {
  /** true iff the CAS matched a FLEX+active row and flipped it. */
  updated: boolean;
  /** Raw Prisma `count` — 1 on success, 0 on CAS-miss. */
  rowsAffected: number;
}

/**
 * CAS-guarded FLEX → CONFIRMED transition.
 *
 * Uses Prisma `updateMany` with `WHERE phase='FLEX' AND status='active'` so
 * the WHERE clause is evaluated atomically against the current row state.
 * Two concurrent callers therefore resolve to exactly ONE `{ updated: true }`
 * — the loser observes `{ updated: false, rowsAffected: 0 }`, and can surface
 * that via `HoldTransitionError` or a 409-style response as appropriate.
 *
 * Designed to be called from inside an existing Prisma transaction
 * (`prismaClient.$transaction` or `withDbTimeout`) so the phase flip is
 * atomic with any neighbouring writes in the confirm saga.
 */
export async function guardedConfirmFlexToConfirmed(
  tx: Prisma.TransactionClient,
  holdId: string,
  patch: GuardedConfirmPatch,
): Promise<GuardedConfirmResult> {
  // Pure FSM check first — a mis-authored caller that passes the wrong from
  // state is caught without a DB round-trip.
  assertHoldPhaseTransition(HoldPhase.FLEX, HoldPhase.CONFIRMED);

  const now = new Date();
  const result = await tx.truckHoldLedger.updateMany({
    where: {
      holdId,
      phase: HoldPhase.FLEX,
      status: 'active',
    },
    data: {
      phase: HoldPhase.CONFIRMED,
      phaseChangedAt: patch.phaseChangedAt ?? now,
      status: 'confirmed',
      confirmedAt: patch.confirmedAt ?? now,
      confirmedExpiresAt: patch.confirmedExpiresAt,
      terminalReason: null,
    },
  });

  return { updated: result.count > 0, rowsAffected: result.count };
}
