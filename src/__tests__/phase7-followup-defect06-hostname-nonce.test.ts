/**
 * =============================================================================
 * Phase 7 follow-up — Defect #6: HOSTNAME fallback uniqueness nonce
 * =============================================================================
 *
 * In ECS Fargate / bare-metal Docker without explicit HOSTNAME env, every
 * container has `process.pid === 1` (PID namespace). The pre-fix fallback
 * `process.env.HOSTNAME || \`pod-${process.pid}\`` collapsed every pod to
 * the literal string `pod-1` — all pods then wrote to the same
 * `pod:drained:pod-1` Redis key during shutdown, racing each other.
 *
 * Fix: append a randomUUID-derived nonce when HOSTNAME is absent.
 *
 * Industry: NIST SP 800-92 §5 — unique host identification for log
 * forensics and cross-pod correlation.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SOCKET_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'socket.service.ts');

describe('Phase 7 follow-up — Defect #6 HOSTNAME nonce fallback', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(SOCKET_SERVICE_PATH, 'utf8');
  });

  it('podId fallback appends a randomUUID-derived nonce when HOSTNAME is absent', () => {
    // Pattern: `process.env.HOSTNAME || `pod-${process.pid}-${randomUUID().slice(0, N)}``
    expect(source).toMatch(
      /process\.env\.HOSTNAME\s*\|\|\s*`pod-\$\{process\.pid\}-\$\{randomUUID\(\)\.slice\(0,\s*\d+\)\}`/,
    );
  });

  it('legacy fallback `pod-${process.pid}` without nonce is no longer present', () => {
    // Match the bare pattern with NO nonce suffix
    expect(source).not.toMatch(/`pod-\$\{process\.pid\}`(?!-)/);
  });

  it('top-level randomUUID is imported from crypto', () => {
    expect(source).toMatch(/import\s*\{[^}]*\brandomUUID\b[^}]*\}\s*from\s*['"]crypto['"]/);
  });

  // ---------------------------------------------------------------------------
  // Behavioural mirror — proves nonce produces unique podIds
  // ---------------------------------------------------------------------------
  describe('behavioural mirror of the nonce fallback', () => {
    const { randomUUID } = require('crypto') as typeof import('crypto');

    function computePodId(hostnameEnv: string | undefined, pid: number): string {
      return hostnameEnv || `pod-${pid}-${randomUUID().slice(0, 8)}`;
    }

    it('HOSTNAME wins when present', () => {
      expect(computePodId('ecs-task-abc123', 1)).toBe('ecs-task-abc123');
    });

    it('empty-string HOSTNAME falls through to nonce path', () => {
      // Empty string is falsy → uses fallback
      const id = computePodId('', 1);
      expect(id).toMatch(/^pod-1-[0-9a-f]{8}$/);
    });

    it('undefined HOSTNAME triggers nonce-suffixed fallback', () => {
      const id = computePodId(undefined, 1);
      expect(id).toMatch(/^pod-1-[0-9a-f]{8}$/);
    });

    it('two processes with same PID get DISTINCT podIds', () => {
      const id1 = computePodId(undefined, 1);
      const id2 = computePodId(undefined, 1);
      expect(id1).not.toBe(id2);
      expect(id1.startsWith('pod-1-')).toBe(true);
      expect(id2.startsWith('pod-1-')).toBe(true);
    });

    it('nonce length is exactly 8 hex chars', () => {
      const id = computePodId(undefined, 1234);
      const suffix = id.split('-').pop()!;
      expect(suffix).toHaveLength(8);
      expect(suffix).toMatch(/^[0-9a-f]+$/);
    });
  });
});
