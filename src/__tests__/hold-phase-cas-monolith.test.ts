/**
 * =============================================================================
 * F-A-79 — HOLD PHASE-CAS MONOLITH TEST (⚠ differentiator-critical)
 * =============================================================================
 *
 * Exercises the new `hold-state-machine.ts` helper:
 *
 *   1. `assertHoldPhaseTransition(from, to)` rejects invalid transitions.
 *   2. `guardedConfirmFlexToConfirmed(tx, holdId, patch)` uses
 *      `updateMany WHERE phase=FLEX AND status=\'active\'` so two concurrent
 *      confirms on the same holdId resolve to exactly ONE `updated:true` —
 *      the loser sees `updated:false`, `rowsAffected:0`.
 *
 * Runs without a live database: we inject a lightweight `tx` stub that
 * simulates PG\'s single-writer-wins semantics for the WHERE clause.
 * That is sufficient to verify the helper\'s CAS contract — the existing
 * `differentiator/two-phase-hold-fsm.test.ts` separately asserts the
 * lock wiring + source-level invariants.
 * =============================================================================
 */

import {
  assertHoldPhaseTransition,
  guardedConfirmFlexToConfirmed,
  HoldTransitionError,
  HOLD_VALID_TRANSITIONS,
} from '../modules/truck-hold/hold-state-machine';

// ---------------------------------------------------------------------------
// assertHoldPhaseTransition — pure FSM guard
// ---------------------------------------------------------------------------

describe('F-A-79 assertHoldPhaseTransition', () => {
  it('accepts FLEX -> CONFIRMED', () => {
    expect(() => assertHoldPhaseTransition('FLEX', 'CONFIRMED')).not.toThrow();
  });

  it('accepts FLEX -> EXPIRED', () => {
    expect(() => assertHoldPhaseTransition('FLEX', 'EXPIRED')).not.toThrow();
  });

  it('accepts FLEX -> RELEASED', () => {
    expect(() => assertHoldPhaseTransition('FLEX', 'RELEASED')).not.toThrow();
  });

  it('accepts CONFIRMED -> RELEASED', () => {
    expect(() => assertHoldPhaseTransition('CONFIRMED', 'RELEASED')).not.toThrow();
  });

  it('accepts CONFIRMED -> EXPIRED', () => {
    expect(() => assertHoldPhaseTransition('CONFIRMED', 'EXPIRED')).not.toThrow();
  });

  it('rejects CONFIRMED -> FLEX (downgrade)', () => {
    expect(() => assertHoldPhaseTransition('CONFIRMED', 'FLEX')).toThrow(HoldTransitionError);
  });

  it('rejects EXPIRED -> CONFIRMED (terminal resurrection)', () => {
    expect(() => assertHoldPhaseTransition('EXPIRED', 'CONFIRMED')).toThrow(HoldTransitionError);
  });

  it('rejects RELEASED -> FLEX (terminal downgrade)', () => {
    expect(() => assertHoldPhaseTransition('RELEASED', 'FLEX')).toThrow(HoldTransitionError);
  });

  it('rejects RELEASED -> CONFIRMED (terminal resurrection)', () => {
    expect(() => assertHoldPhaseTransition('RELEASED', 'CONFIRMED')).toThrow(HoldTransitionError);
  });

  it('rejects FLEX -> FLEX (self-loop)', () => {
    expect(() => assertHoldPhaseTransition('FLEX', 'FLEX')).toThrow(HoldTransitionError);
  });

  it('HOLD_VALID_TRANSITIONS is a frozen constant (pure data, no writes)', () => {
    expect(HOLD_VALID_TRANSITIONS.FLEX).toEqual(['CONFIRMED', 'EXPIRED', 'RELEASED']);
    expect(HOLD_VALID_TRANSITIONS.CONFIRMED).toEqual(['RELEASED', 'EXPIRED']);
    expect(HOLD_VALID_TRANSITIONS.EXPIRED).toEqual([]);
    expect(HOLD_VALID_TRANSITIONS.RELEASED).toEqual([]);
  });

  it('HoldTransitionError carries from/to/reason context', () => {
    try {
      assertHoldPhaseTransition('CONFIRMED', 'FLEX');
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HoldTransitionError);
      const e = err as HoldTransitionError;
      expect(e.from).toBe('CONFIRMED');
      expect(e.to).toBe('FLEX');
      expect(e.message).toContain('FLEX');
      expect(e.message).toContain('CONFIRMED');
    }
  });
});

// ---------------------------------------------------------------------------
// guardedConfirmFlexToConfirmed — CAS-backed updateMany
// ---------------------------------------------------------------------------

interface LedgerRow {
  holdId: string;
  phase: string;
  status: string;
  confirmedAt: Date | null;
  confirmedExpiresAt: Date | null;
  phaseChangedAt: Date | null;
}

function makeTxStub(initial: LedgerRow) {
  const state: LedgerRow = { ...initial };
  const tx = {
    truckHoldLedger: {
      updateMany: jest.fn(
        async (args: { where: { holdId: string; phase?: string; status?: string }; data: Partial<LedgerRow> }) => {
          const whereMatches =
            state.holdId === args.where.holdId &&
            (args.where.phase === undefined || state.phase === args.where.phase) &&
            (args.where.status === undefined || state.status === args.where.status);
          if (!whereMatches) {
            return { count: 0 };
          }
          Object.assign(state, args.data);
          return { count: 1 };
        },
      ),
    },
  };
  return { tx, state };
}

describe('F-A-79 guardedConfirmFlexToConfirmed', () => {
  const holdId = 'hold-abc-123';
  const baseRow: LedgerRow = {
    holdId,
    phase: 'FLEX',
    status: 'active',
    confirmedAt: null,
    confirmedExpiresAt: null,
    phaseChangedAt: null,
  };
  const confirmedExpiresAt = new Date(Date.now() + 180_000);

  it('flips FLEX+active row to CONFIRMED+confirmed atomically', async () => {
    const { tx, state } = makeTxStub(baseRow);
    const r = await guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
      confirmedExpiresAt,
    });
    expect(r.updated).toBe(true);
    expect(r.rowsAffected).toBe(1);
    expect(state.phase).toBe('CONFIRMED');
    expect(state.status).toBe('confirmed');
    expect(state.confirmedAt).toBeInstanceOf(Date);
    expect(state.confirmedExpiresAt).toEqual(confirmedExpiresAt);
    expect(state.phaseChangedAt).toBeInstanceOf(Date);
  });

  it('CAS-misses on a row already CONFIRMED (returns updated:false, rowsAffected:0)', async () => {
    const alreadyConfirmed: LedgerRow = {
      ...baseRow,
      phase: 'CONFIRMED',
      status: 'confirmed',
      confirmedAt: new Date(),
    };
    const { tx, state } = makeTxStub(alreadyConfirmed);
    const r = await guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
      confirmedExpiresAt,
    });
    expect(r.updated).toBe(false);
    expect(r.rowsAffected).toBe(0);
    expect(state.phase).toBe('CONFIRMED');
    expect(state.status).toBe('confirmed');
  });

  it('CAS-misses on a row already EXPIRED (terminal)', async () => {
    const expired: LedgerRow = { ...baseRow, phase: 'EXPIRED', status: 'expired' };
    const { tx, state } = makeTxStub(expired);
    const r = await guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
      confirmedExpiresAt,
    });
    expect(r.updated).toBe(false);
    expect(r.rowsAffected).toBe(0);
    expect(state.phase).toBe('EXPIRED');
  });

  it('CAS-misses on a row already RELEASED (terminal)', async () => {
    const released: LedgerRow = { ...baseRow, phase: 'RELEASED', status: 'released' };
    const { tx, state } = makeTxStub(released);
    const r = await guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
      confirmedExpiresAt,
    });
    expect(r.updated).toBe(false);
    expect(r.rowsAffected).toBe(0);
  });

  it('two concurrent confirms on the same holdId: exactly ONE wins, other sees updated:false', async () => {
    const { tx } = makeTxStub(baseRow);

    const [r1, r2] = await Promise.all([
      guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
        confirmedExpiresAt,
      }),
      guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
        confirmedExpiresAt,
      }),
    ]);

    const winners = [r1, r2].filter((r) => r.updated);
    const losers = [r1, r2].filter((r) => !r.updated);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].rowsAffected).toBe(1);
    expect(losers[0].rowsAffected).toBe(0);
    expect(tx.truckHoldLedger.updateMany).toHaveBeenCalledTimes(2);
  });

  it('uses updateMany (NOT update) so CAS failure produces rowsAffected:0 instead of throwing', async () => {
    const { tx } = makeTxStub(baseRow);
    await guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
      confirmedExpiresAt,
    });
    const [call] = tx.truckHoldLedger.updateMany.mock.calls;
    expect(call[0].where).toEqual({ holdId, phase: 'FLEX', status: 'active' });
    expect(call[0].data.phase).toBe('CONFIRMED');
    expect(call[0].data.status).toBe('confirmed');
    expect(call[0].data.confirmedExpiresAt).toEqual(confirmedExpiresAt);
  });

  it('honours caller-provided phaseChangedAt/confirmedAt override', async () => {
    const { tx, state } = makeTxStub(baseRow);
    const ts = new Date('2026-04-18T12:00:00Z');
    await guardedConfirmFlexToConfirmed(tx as unknown as Parameters<typeof guardedConfirmFlexToConfirmed>[0], holdId, {
      confirmedAt: ts,
      confirmedExpiresAt,
      phaseChangedAt: ts,
    });
    expect(state.confirmedAt).toEqual(ts);
    expect(state.phaseChangedAt).toEqual(ts);
  });
});
