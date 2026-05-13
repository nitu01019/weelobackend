/**
 * =============================================================================
 * PHASE 5 — FIX #6 — Idempotent-Replayed response header (Stripe parity)
 * =============================================================================
 *
 * Validates:
 *   (a) Fresh response (`replayed !== true`) → helper is a NO-OP; no
 *       `Idempotent-Replayed` header is emitted; no `X-Weelo-Replay-Source`
 *       header is emitted.
 *   (b) Replay response (`replayed === true`) in non-development NODE_ENV
 *       (e.g. 'production') → only `Idempotent-Replayed: true`; the
 *       `X-Weelo-Replay-Source` header MUST be absent (Stripe wire parity).
 *   (c) Replay response (`replayed === true`) in NODE_ENV='development' →
 *       BOTH `Idempotent-Replayed: true` AND `X-Weelo-Replay-Source: <src>`
 *       are emitted; `<src>` is one of `'redis-cache' | 'db-replay'`.
 *   (d) Replay response with `replaySource` omitted in development → only
 *       `Idempotent-Replayed: true` (helper short-circuits the dev source
 *       header when no source value is present).
 *   (e) Production hardening: NODE_ENV='staging' (anything !== 'development')
 *       must NOT leak X-Weelo-Replay-Source even when replaySource is set —
 *       Niko R5-B opt-in semantics.
 *   (f) Grep oracle: `setIdempotentReplayedHeader(` must be invoked at
 *       ≥5 production callsites across order.routes / booking.routes /
 *       booking-crud.routes / broadcast.routes — proves the Stripe header
 *       lands on every idempotent POST that emits a 201/200 replay.
 * =============================================================================
 */

import { execSync } from 'child_process';
import * as path from 'path';
import {
  setIdempotentReplayedHeader,
  type IdempotentReplayResult,
  type ReplaySource,
} from '../shared/http/idempotency-headers';

// =============================================================================
// Test double for Express Response — only setHeader is exercised by helper
// =============================================================================
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = String(value);
    }),
    getHeader: (name: string): string | undefined => headers[name.toLowerCase()],
    _headers: headers,
  };
}

describe('phase5-fix6 — Idempotent-Replayed header (Stripe parity)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  describe('(a) fresh response — helper is no-op', () => {
    it('does not set Idempotent-Replayed when replayed is undefined', () => {
      const res = makeRes();
      const result: IdempotentReplayResult = {};
      setIdempotentReplayedHeader(res as never, result);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.getHeader('Idempotent-Replayed')).toBeUndefined();
      expect(res.getHeader('X-Weelo-Replay-Source')).toBeUndefined();
    });

    it('does not set Idempotent-Replayed when replayed is false', () => {
      const res = makeRes();
      setIdempotentReplayedHeader(res as never, { replayed: false });
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('does not set headers even if replaySource is present but replayed is not true', () => {
      const res = makeRes();
      // Cast: simulates a buggy caller that forgot to set replayed but did set source.
      // Helper must still short-circuit because Stripe-parity contract gates on `replayed === true`.
      setIdempotentReplayedHeader(res as never, {
        replaySource: 'redis-cache',
      } as IdempotentReplayResult);
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  describe('(b) replay in production — header SET, dev-source ABSENT', () => {
    it('NODE_ENV=production: sets Idempotent-Replayed but omits X-Weelo-Replay-Source', () => {
      process.env.NODE_ENV = 'production';
      const res = makeRes();
      setIdempotentReplayedHeader(res as never, {
        replayed: true,
        replaySource: 'redis-cache',
      });
      expect(res.getHeader('Idempotent-Replayed')).toBe('true');
      expect(res.getHeader('X-Weelo-Replay-Source')).toBeUndefined();
      // Stripe-parity assertion: only one setHeader call total in prod.
      expect(res.setHeader).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    });

    it('NODE_ENV=production with replaySource=db-replay — same wire contract', () => {
      process.env.NODE_ENV = 'production';
      const res = makeRes();
      setIdempotentReplayedHeader(res as never, {
        replayed: true,
        replaySource: 'db-replay',
      });
      expect(res.getHeader('Idempotent-Replayed')).toBe('true');
      expect(res.getHeader('X-Weelo-Replay-Source')).toBeUndefined();
    });
  });

  describe('(c) replay in development — BOTH headers present', () => {
    it.each<ReplaySource>(['redis-cache', 'db-replay'])(
      'NODE_ENV=development + replaySource=%s emits both headers',
      (src) => {
        process.env.NODE_ENV = 'development';
        const res = makeRes();
        setIdempotentReplayedHeader(res as never, {
          replayed: true,
          replaySource: src,
        });
        expect(res.getHeader('Idempotent-Replayed')).toBe('true');
        expect(res.getHeader('X-Weelo-Replay-Source')).toBe(src);
        expect(res.setHeader).toHaveBeenCalledTimes(2);
      },
    );
  });

  describe('(d) replay in development without replaySource — dev header skipped', () => {
    it('emits only Idempotent-Replayed when replaySource is omitted', () => {
      process.env.NODE_ENV = 'development';
      const res = makeRes();
      setIdempotentReplayedHeader(res as never, { replayed: true });
      expect(res.getHeader('Idempotent-Replayed')).toBe('true');
      expect(res.getHeader('X-Weelo-Replay-Source')).toBeUndefined();
      expect(res.setHeader).toHaveBeenCalledTimes(1);
    });
  });

  describe('(e) Niko R5-B opt-in: only NODE_ENV=development unlocks dev source header', () => {
    it.each(['staging', 'test', 'qa', '', undefined])(
      'NODE_ENV=%s does NOT emit X-Weelo-Replay-Source even with replaySource set',
      (env) => {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env as string;
        const res = makeRes();
        setIdempotentReplayedHeader(res as never, {
          replayed: true,
          replaySource: 'redis-cache',
        });
        expect(res.getHeader('Idempotent-Replayed')).toBe('true');
        expect(res.getHeader('X-Weelo-Replay-Source')).toBeUndefined();
      },
    );
  });

  describe('(f) grep oracle — production callsite count', () => {
    it('setIdempotentReplayedHeader is called at ≥5 production routes', () => {
      const repoRoot = path.resolve(__dirname, '..', '..');
      // Exclude the helper definition itself and any test files; count only src/modules/**.
      const out = execSync(
        'grep -rn "setIdempotentReplayedHeader(" src/modules/ || true',
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const lines = out
        .split('\n')
        .filter((l) => l.trim().length > 0 && !l.includes('idempotency-headers.ts'));
      // Required production routes:
      //   - order.routes.ts                  (canonical POST /api/v1/orders)
      //   - booking.routes.ts                (legacy proxy + bookingService.createBooking + canonical-relay)
      //   - booking-crud.routes.ts           (legacy proxy + bookingService.createBooking + canonical-relay)
      //   - broadcast.routes.ts              (accept replay header)
      // Stripe-parity contract requires ≥5 callsites across these files.
      expect(lines.length).toBeGreaterThanOrEqual(5);
      const filesTouched = new Set(lines.map((l) => l.split(':')[0]));
      expect(filesTouched).toContain('src/modules/order/order.routes.ts');
      expect(filesTouched).toContain('src/modules/booking/booking.routes.ts');
      expect(filesTouched).toContain('src/modules/booking/booking-crud.routes.ts');
      expect(filesTouched).toContain('src/modules/broadcast/broadcast.routes.ts');
    });
  });

  describe('(g) broadcast adapter shape — { replayed: result.replayed === true }', () => {
    it('falsy boolean coerced via === true short-circuits (no header)', () => {
      process.env.NODE_ENV = 'production';
      const res = makeRes();
      // Simulates broadcast.routes.ts:222 adapter when service returns replayed=false
      const adapter = { replayed: (false as boolean) === true };
      setIdempotentReplayedHeader(res as never, adapter);
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('truthy boolean coerced via === true emits header', () => {
      process.env.NODE_ENV = 'production';
      const res = makeRes();
      const adapter = { replayed: (true as boolean) === true };
      setIdempotentReplayedHeader(res as never, adapter);
      expect(res.getHeader('Idempotent-Replayed')).toBe('true');
    });
  });
});
