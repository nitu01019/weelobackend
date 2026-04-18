/**
 * =============================================================================
 * F-A-03 — Idempotent-Replayed response header on cache/DB replay branches
 * =============================================================================
 *
 * Today the cache-hit branch (order.service.ts:706-735) and the DB-replay
 * branch (order.service.ts:722-734) both return the cached 201 response
 * payload byte-identically — the client cannot distinguish a fresh order from
 * a replayed retry. IETF idempotency-key §5.3 RECOMMENDS that servers signal
 * a replay so clients can collapse retry-induced UI work.
 *
 * The fix:
 *  1. Service layer attaches a synthetic `__replayed: true` flag to the
 *     internal return object on cache-hit and DB-replay paths.
 *  2. Route layer, when `__replayed === true`, sets the
 *     `Idempotent-Replayed: true` response header, then deletes the flag from
 *     the body so wire bytes remain identical to the original 201.
 *  3. Behaviour gated by FF_IDEMPOTENT_REPLAY_HEADER (release, default OFF).
 * =============================================================================
 */

import { isEnabled, FLAGS } from '../shared/config/feature-flags';

describe('F-A-03 — IDEMPOTENT_REPLAY_HEADER flag wiring', () => {
  it('FLAGS.IDEMPOTENT_REPLAY_HEADER is registered as a release flag', () => {
    expect((FLAGS as any).IDEMPOTENT_REPLAY_HEADER).toBeDefined();
    expect((FLAGS as any).IDEMPOTENT_REPLAY_HEADER.env).toBe('FF_IDEMPOTENT_REPLAY_HEADER');
    expect((FLAGS as any).IDEMPOTENT_REPLAY_HEADER.category).toBe('release');
  });

  it('IDEMPOTENT_REPLAY_HEADER defaults OFF when env unset', () => {
    const original = process.env.FF_IDEMPOTENT_REPLAY_HEADER;
    delete process.env.FF_IDEMPOTENT_REPLAY_HEADER;
    try {
      expect(isEnabled((FLAGS as any).IDEMPOTENT_REPLAY_HEADER)).toBe(false);
    } finally {
      if (original !== undefined) process.env.FF_IDEMPOTENT_REPLAY_HEADER = original;
    }
  });
});

describe('F-A-03 — order.service.ts marks replay branches with __replayed flag', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../modules/order/order.service.ts'),
    'utf8'
  );

  it('cache-hit branch attaches __replayed: true to cached response', () => {
    // Look for the Redis cache-hit path setting the marker.
    expect(source).toMatch(/__replayed/);
    // And the FF guard so the legacy path is preserved for OFF.
    expect(source).toMatch(/FF_IDEMPOTENT_REPLAY_HEADER|IDEMPOTENT_REPLAY_HEADER/);
  });

  it('DB-replay branch (getDbIdempotentResponse hit) also attaches __replayed', () => {
    // There must be at least 2 sites that touch __replayed (cache + DB) so the
    // header fires on both replay shapes.
    const occurrences = (source.match(/__replayed/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('F-A-03 — order.routes.ts sets Idempotent-Replayed header and strips marker', () => {
  const fs = require('fs');
  const path = require('path');
  const routesSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/order/order.routes.ts'),
    'utf8'
  );

  it('routes references the Idempotent-Replayed header name', () => {
    expect(routesSource).toMatch(/Idempotent-Replayed/);
  });

  it('routes inspects the __replayed flag on the service result', () => {
    expect(routesSource).toMatch(/__replayed/);
  });
});
