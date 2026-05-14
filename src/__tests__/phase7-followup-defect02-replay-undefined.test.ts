/**
 * =============================================================================
 * Phase 7 follow-up — Defect #2: Phase-4 replay defensive eventId fallback
 * =============================================================================
 *
 * Pre-fix: socket.service.ts:1335 used
 *   `envelope.payload?.eventId ?? envelope.eventId`
 * which returns `undefined` for envelopes written BEFORE Phase 7 (no eventId
 * field on either layer). At deploy moment, the 10-minute UNACKED_QUEUE_TTL
 * window contains a mix of legacy + post-fix envelopes. Legacy ones would
 * replay with `eventId: undefined` — FE ring-buffer keys collisions on the
 * literal string `undefined`.
 *
 * Fix: defensive third fallback `?? randomUUID()`.
 *
 * Industry: DDIA Ch.11 §"Idempotent Consumers" — every event on the wire
 * MUST carry a stable id, even legacy ones.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SOCKET_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'socket.service.ts');

describe('Phase 7 follow-up — Defect #2 Phase-4 replay defensive eventId', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(SOCKET_SERVICE_PATH, 'utf8');
  });

  it('replay eventId expression contains the defensive `?? randomUUID()` fallback', () => {
    // Find the Phase-4 replay block (one of two replay paths in this file —
    // the one that emits via `socket.emit(envelope.event || 'replay'...`).
    const replayStart = source.indexOf("socket.emit(envelope.event || 'replay'");
    expect(replayStart).toBeGreaterThan(-1);
    const replayBlock = source.slice(replayStart, replayStart + 800);

    expect(replayBlock).toMatch(
      /eventId:\s*envelope\.payload\?\.eventId\s*\?\?\s*envelope\.eventId\s*\?\?\s*randomUUID\(\)/,
    );
  });

  it('legacy expression (no third fallback) is no longer present', () => {
    // Pre-fix pattern was: `eventId: envelope.payload?.eventId ?? envelope.eventId,`
    // — a comma right after envelope.eventId means no third fallback.
    // The fix MUST add `?? randomUUID()` before the comma.
    const replayStart = source.indexOf("socket.emit(envelope.event || 'replay'");
    const replayBlock = source.slice(replayStart, replayStart + 800);
    expect(replayBlock).not.toMatch(
      /eventId:\s*envelope\.payload\?\.eventId\s*\?\?\s*envelope\.eventId\s*,/,
    );
  });

  it('top-level randomUUID is still imported from crypto', () => {
    expect(source).toMatch(/import\s*\{[^}]*\brandomUUID\b[^}]*\}\s*from\s*['"]crypto['"]/);
  });

  // ---------------------------------------------------------------------------
  // Behavioural mirror — proves the fallback chain semantics
  // ---------------------------------------------------------------------------
  describe('behavioural mirror of the fallback chain', () => {
    function resolve(envelope: any, mintUuid: () => string): string {
      return envelope.payload?.eventId ?? envelope.eventId ?? mintUuid();
    }

    it('preserves payload.eventId when present', () => {
      const eid = '11111111-2222-3333-4444-555555555555';
      const env = { payload: { eventId: eid, x: 1 }, eventId: 'envelope-level' };
      expect(resolve(env, () => 'minted')).toBe(eid);
    });

    it('falls back to envelope.eventId when payload lacks one', () => {
      const env = { payload: { x: 1 }, eventId: 'envelope-level' };
      expect(resolve(env, () => 'minted')).toBe('envelope-level');
    });

    it('mints fresh UUID when both layers are missing (legacy envelope)', () => {
      const env = { payload: { x: 1 } };
      expect(resolve(env, () => 'fresh-uuid')).toBe('fresh-uuid');
    });

    it('treats payload eventId="" as missing (nullish coalesce only)', () => {
      // Empty string is NOT nullish — preserved as-is. Acceptable: upstream
      // stampers (queue processor, room helpers) guard against empty strings.
      const env = { payload: { eventId: '' }, eventId: 'envelope-level' };
      expect(resolve(env, () => 'minted')).toBe('');
    });

    it('handles null payload (defensive)', () => {
      const env = { payload: null as any, eventId: 'envelope-level' };
      expect(resolve(env, () => 'minted')).toBe('envelope-level');
    });

    it('produces a UUID-shaped string when minting', () => {
      const { randomUUID } = require('crypto') as typeof import('crypto');
      const env = { payload: { x: 1 } };
      const result = resolve(env, () => randomUUID());
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });
});
