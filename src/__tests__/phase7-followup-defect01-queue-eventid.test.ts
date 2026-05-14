/**
 * =============================================================================
 * Phase 7 follow-up — Defect #1: Queue processor ZSET envelope eventId stamping
 * =============================================================================
 *
 * Pre-fix: the queue processor at queue.service.ts:1308 writes
 *   JSON.stringify({ seq, event, payload: data, createdAt })
 * — raw `data` with NO eventId. When FF_SEQUENCE_DELIVERY_ENABLED=true,
 * replay at socket.service.ts:1335 returns `payload?.eventId ?? envelope.eventId
 * ?? undefined`. FE ring-buffer keys collisions on the literal `undefined`.
 *
 * Fix: mint or preserve eventId on a fresh `dataWithEventId` clone (reuses
 * the verbatim pattern from queue.service.ts:1950-1952). Envelope carries
 * eventId both at top level and inside payload. _seq mutation moves to the
 * clone (side-effect: closes Defect #7's shared-payload mutation hazard for
 * the FF_SEQUENCE path).
 *
 * Industry: DDIA Ch.11 §"Idempotent Consumers" — stable business-event id
 * across every retransmission path.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const QUEUE_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'queue.service.ts');

describe('Phase 7 follow-up — Defect #1 queue processor eventId stamping', () => {
  let source: string;
  let phase4SeqBlock: string;

  beforeAll(() => {
    source = readFileSync(QUEUE_SERVICE_PATH, 'utf8');
    // Slice from the FF_SEQUENCE branch through both emitToUser call sites
    // (FF_DUAL_CHANNEL_DELIVERY + fallback). 6000 bytes covers the whole region.
    const start = source.indexOf('=== PHASE 4: SEQUENCE NUMBERING (flag-gated) ===');
    expect(start).toBeGreaterThan(-1);
    phase4SeqBlock = source.slice(start, start + 6000);
  });

  // ---------------------------------------------------------------------------
  // (a) Envelope payload carries eventId
  // ---------------------------------------------------------------------------
  describe('envelope payload carries eventId before ZADD', () => {
    it('declares a dataWithEventId clone before JSON.stringify', () => {
      // Pattern mirrors L1950-1952 (DLQ stamping). Accept either `const` or
      // `let` declaration — the SEQ path needs to declare dataWithEventId at a
      // wider scope (outside try/catch) so the emitToUser fall-through can use
      // it. Verify the clone-with-eventId spread regardless of declaration form.
      expect(phase4SeqBlock).toMatch(/\b(?:const|let)\s+dataWithEventId\b/);
      expect(phase4SeqBlock).toMatch(
        /dataWithEventId\s*=[\s\S]{0,400}\.\.\.[\s\S]{0,200}eventId:[\s\S]{0,80}crypto\.randomUUID\(\)/,
      );
    });

    it('envelope.payload references dataWithEventId (not raw data)', () => {
      expect(phase4SeqBlock).toMatch(/payload:\s*dataWithEventId/);
      // Negative: the raw `payload: data` pattern (pre-fix) must be gone.
      expect(phase4SeqBlock).not.toMatch(/payload:\s*data\s*,\s*createdAt/);
    });

    it('does NOT write raw data into the envelope (pre-fix bug)', () => {
      expect(phase4SeqBlock).not.toMatch(
        /JSON\.stringify\(\s*\{\s*seq\s*,\s*event\s*,\s*payload:\s*data\s*,/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // (b) _seq mutation lands on the CLONE (closes Defect #7)
  // ---------------------------------------------------------------------------
  describe('_seq mutation targets the clone (not the shared payload)', () => {
    it('mutates _seq on dataWithEventId (the clone)', () => {
      expect(phase4SeqBlock).toMatch(/dataWithEventId[\s\S]{0,100}\._seq\s*=\s*seq/);
    });

    it('does NOT mutate the original `data._seq` directly (closes #7 for this path)', () => {
      // Pattern: `data._seq = seq;` (with no `WithEventId` between) — should be gone.
      // Use a regex that explicitly excludes the WithEventId clone.
      const rawDataSeqMutation = /(?<!WithEventId\s*as\s*Record<string,\s*unknown>\)|WithEventId)\bdata\._seq\s*=\s*seq/;
      expect(phase4SeqBlock).not.toMatch(rawDataSeqMutation);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) emitToUser receives the stamped clone
  // ---------------------------------------------------------------------------
  describe('emitToUser receives the stamped clone', () => {
    it('passes dataWithEventId to emitToUser (not raw data)', () => {
      expect(phase4SeqBlock).toMatch(/emitToUser\(\s*transporterId\s*,\s*event\s*,\s*dataWithEventId\s*\)/);
    });
  });

  // ---------------------------------------------------------------------------
  // (d) Behavioural mirror — the stamping pattern's correctness
  // ---------------------------------------------------------------------------
  describe('behavioural mirror of the stamping pattern', () => {
    function mirror(data: unknown, seq: number): {
      envelopeStr: string;
      emitArg: unknown;
      originalSeqPreserved: boolean;
    } {
      const crypto = require('crypto') as typeof import('crypto');
      const dataWithEventId =
        data && typeof data === 'object' && !Array.isArray(data)
          ? { ...(data as Record<string, unknown>), eventId: (data as any).eventId ?? crypto.randomUUID() }
          : data;

      const envelopeStr = JSON.stringify({
        seq,
        event: 'broadcast_assigned',
        eventId: (dataWithEventId as any)?.eventId,
        payload: dataWithEventId,
        createdAt: Date.now(),
      });

      if (dataWithEventId && typeof dataWithEventId === 'object') {
        (dataWithEventId as Record<string, unknown>)._seq = seq;
      }

      const originalHasSeq =
        data && typeof data === 'object' && '_seq' in (data as Record<string, unknown>);

      return {
        envelopeStr,
        emitArg: dataWithEventId,
        originalSeqPreserved: !originalHasSeq, // original should NOT have _seq mutated in
      };
    }

    it('mints UUID eventId when raw data lacks one', () => {
      const { envelopeStr } = mirror({ orderId: 'o1' }, 42);
      const env = JSON.parse(envelopeStr);
      expect(env.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(env.payload.eventId).toBe(env.eventId);
    });

    it('preserves existing eventId when raw data already has one', () => {
      const stable = '11111111-2222-3333-4444-555555555555';
      const { envelopeStr } = mirror({ orderId: 'o1', eventId: stable }, 7);
      const env = JSON.parse(envelopeStr);
      expect(env.eventId).toBe(stable);
      expect(env.payload.eventId).toBe(stable);
    });

    it('original payload is NOT mutated with _seq (closes Defect #7)', () => {
      const original = { orderId: 'o1' };
      mirror(original, 123);
      expect(original).not.toHaveProperty('_seq');
    });

    it('emitArg is the clone with _seq attached', () => {
      const { emitArg } = mirror({ orderId: 'o1' }, 99);
      expect((emitArg as any)._seq).toBe(99);
      expect((emitArg as any).eventId).toMatch(/^[0-9a-f]{8}-/);
    });

    it('non-cloneable payload (string, number) passes through unchanged', () => {
      // String case — typeof !== 'object' so neither clone nor _seq mutation fires
      const { emitArg: strArg } = mirror('hello', 2);
      expect(strArg).toBe('hello');
      // Number case
      const { emitArg: numArg } = mirror(42, 3);
      expect(numArg).toBe(42);
    });

    it('array payload: no eventId clone but _seq still attaches (matches existing L1951 pattern)', () => {
      // Arrays match `typeof === 'object'` but `!Array.isArray()` is false, so the
      // L1951 ternary's false-branch returns the array itself — no clone, no eventId
      // stamp. The subsequent _seq mutation still fires (matches existing behavior).
      // Production payloads are objects (typed event shapes); arrays here are
      // theoretical edge cases.
      const input: any[] = ['a', 'b'];
      const { emitArg } = mirror(input, 1);
      expect(emitArg).toBe(input); // same reference — no clone
      expect((emitArg as any)._seq).toBe(1);
      expect((emitArg as any).eventId).toBeUndefined();
    });
  });
});
