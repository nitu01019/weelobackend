/**
 * =============================================================================
 * Phase 7 follow-up — Defect #11: Role label cardinality clamp
 * =============================================================================
 *
 * Pre-fix: `socket_reconnect_post_drain_total{role}` accepted whatever was on
 * `socket.data.role`. JWT validation upstream SHOULD reject unknown roles,
 * but Prometheus cardinality is a safety property — defense in depth.
 *
 * Fix: clamp to allowlist {customer, transporter, driver, admin} at the
 * Phase 7-introduced call site (socket.service.ts:368-374). Pre-existing
 * call sites at L316 / L339 are out of scope for this sprint.
 *
 * Industry: Prometheus / CNCF Observability TAG — label cardinality must be
 * bounded; never accept unbounded user-controlled strings.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SOCKET_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'socket.service.ts');

describe('Phase 7 follow-up — Defect #11 role label cardinality clamp', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(SOCKET_SERVICE_PATH, 'utf8');
  });

  // ---------------------------------------------------------------------------
  // (a) Allowlist exists at module scope
  // ---------------------------------------------------------------------------
  it('declares KNOWN_ROLES allowlist at module scope', () => {
    expect(source).toMatch(
      /const\s+KNOWN_ROLES\s*=\s*new Set\s*\(\s*\[\s*['"]customer['"],\s*['"]transporter['"],\s*['"]driver['"],\s*['"]admin['"]\s*\]\s*\)/,
    );
  });

  // ---------------------------------------------------------------------------
  // (b) Phase 7 call site uses the clamp
  // ---------------------------------------------------------------------------
  it('socket_reconnect_post_drain_total increment uses the clamp', () => {
    // Anchor on the incrementCounter CALL (not the comment that mentions the
    // counter name). The call appears exactly once in this file.
    const callIdx = source.indexOf("incrementCounter('socket_reconnect_post_drain_total'");
    expect(callIdx).toBeGreaterThan(-1);
    // 400-byte window around the call captures the role-resolution line
    const block = source.slice(Math.max(0, callIdx - 400), callIdx + 400);
    // Pattern: KNOWN_ROLES.has(socket.data.role) ? socket.data.role : 'unknown'
    expect(block).toMatch(/KNOWN_ROLES\.has\([^)]*socket\.data\.role[^)]*\)/);
  });

  it('does NOT use the bare `socket.data.role || \'unknown\'` (pre-fix) at the Phase 7 site', () => {
    const callIdx = source.indexOf("incrementCounter('socket_reconnect_post_drain_total'");
    const block = source.slice(Math.max(0, callIdx - 400), callIdx + 400);
    // Pre-fix pattern: `role: socket.data.role || 'unknown'`
    expect(block).not.toMatch(/role:\s*socket\.data\.role\s*\|\|\s*['"]unknown['"]/);
  });

  // ---------------------------------------------------------------------------
  // (c) Behavioural mirror — clamp semantics
  // ---------------------------------------------------------------------------
  describe('behavioural mirror of the clamp semantics', () => {
    const KNOWN = new Set(['customer', 'transporter', 'driver', 'admin']);
    function clamp(role: unknown): string {
      return typeof role === 'string' && KNOWN.has(role) ? role : 'unknown';
    }

    it('preserves valid roles', () => {
      expect(clamp('customer')).toBe('customer');
      expect(clamp('transporter')).toBe('transporter');
      expect(clamp('driver')).toBe('driver');
      expect(clamp('admin')).toBe('admin');
    });

    it('clamps unknown string roles to "unknown"', () => {
      expect(clamp('dispatcher')).toBe('unknown');
      expect(clamp('attacker_injected')).toBe('unknown');
      expect(clamp('')).toBe('unknown');
      expect(clamp('CUSTOMER')).toBe('unknown'); // case-sensitive
    });

    it('clamps non-string types to "unknown"', () => {
      expect(clamp(undefined)).toBe('unknown');
      expect(clamp(null)).toBe('unknown');
      expect(clamp(0)).toBe('unknown');
      expect(clamp(true)).toBe('unknown');
      expect(clamp({ admin: true })).toBe('unknown');
      expect(clamp(['customer'])).toBe('unknown');
    });
  });
});
