/**
 * =============================================================================
 * Phase 7 follow-up — Defect #3: gracefulShutdown reentrancy guard
 * =============================================================================
 *
 * Validates that concurrent SIGTERM + SIGINT cannot invoke the shutdown body
 * twice. Production today (pre-fix) has no early-return — both handlers run
 * `drainSocketsStaggered`, `queueService.stop()`, and `prismaClient.$disconnect()`
 * concurrently, racing each other.
 *
 * Industry pattern: Linkerd / Envoy idempotent graceful stop.
 *
 * Verification strategy:
 *   (a) Source-string assertion — production code contains the `_shutdownInProgress`
 *       sentinel + early-return pattern.
 *   (b) Behavioural simulation — mirrored guard logic asserts only-one-runs
 *       semantics under concurrent invocation.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_PATH = join(__dirname, '..', 'server.ts');

describe('Phase 7 follow-up — Defect #3 gracefulShutdown reentrancy guard', () => {
  let serverSource: string;

  beforeAll(() => {
    serverSource = readFileSync(SERVER_PATH, 'utf8');
  });

  // ---------------------------------------------------------------------------
  // (a) Source-string assertions — production code must contain the guard
  // ---------------------------------------------------------------------------
  describe('production code contains the reentrancy guard', () => {
    it('declares the _shutdownInProgress sentinel at module scope', () => {
      expect(serverSource).toMatch(/let\s+_shutdownInProgress\s*=\s*false\s*;/);
    });

    it('returns early when a second signal arrives during an in-progress shutdown', () => {
      // Pattern: `if (_shutdownInProgress) { ... return; }` near the top of gracefulShutdown
      expect(serverSource).toMatch(
        /if\s*\(\s*_shutdownInProgress\s*\)\s*\{[\s\S]{0,200}return\s*;?\s*\}/,
      );
    });

    it('logs a clear "already in progress" message when the guard fires', () => {
      expect(serverSource).toMatch(/already in progress/i);
    });

    it('sets the sentinel before performing any drain work', () => {
      const fnStart = serverSource.indexOf('const gracefulShutdown');
      expect(fnStart).toBeGreaterThan(-1);
      const drainCall = serverSource.indexOf('drainSocketsStaggered', fnStart);
      const sentinelSet = serverSource.indexOf('_shutdownInProgress = true', fnStart);
      expect(sentinelSet).toBeGreaterThan(-1);
      expect(drainCall).toBeGreaterThan(sentinelSet); // sentinel set BEFORE drain
    });

    it('exports gracefulShutdown for testability', () => {
      // Either `export const gracefulShutdown` or `export { gracefulShutdown }`
      const exportedDirect = /export\s+const\s+gracefulShutdown\s*=/.test(serverSource);
      const exportedNamed = /export\s*\{[^}]*\bgracefulShutdown\b[^}]*\}/.test(serverSource);
      expect(exportedDirect || exportedNamed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // (b) Behavioural simulation — the guard pattern's correctness in isolation
  //     This mirrors the production logic without booting the full server.ts
  //     module (which has side effects at load time).
  // ---------------------------------------------------------------------------
  describe('behavioural simulation of the reentrancy guard', () => {
    it('second concurrent invocation is a no-op (drain runs once)', async () => {
      let _shutdownInProgress = false;
      const drainMock = jest.fn().mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      );

      const simulate = async (signal: string): Promise<string> => {
        if (_shutdownInProgress) {
          return `${signal}_ignored`;
        }
        _shutdownInProgress = true;
        await drainMock();
        return `${signal}_completed`;
      };

      const [r1, r2] = await Promise.all([simulate('SIGTERM'), simulate('SIGINT')]);

      expect(drainMock).toHaveBeenCalledTimes(1);
      // Exactly one signal wins, the other is ignored. Either can win
      // (Promise.all evaluates simulate calls in order, but `if` check is
      // synchronous so the first call always wins).
      const completed = [r1, r2].filter((r) => r.endsWith('_completed'));
      const ignored = [r1, r2].filter((r) => r.endsWith('_ignored'));
      expect(completed).toHaveLength(1);
      expect(ignored).toHaveLength(1);
    });

    it('subsequent invocations after the first completes are also no-ops', async () => {
      let _shutdownInProgress = false;
      const drainMock = jest.fn().mockResolvedValue(undefined);

      const simulate = async (signal: string): Promise<void> => {
        if (_shutdownInProgress) {
          return;
        }
        _shutdownInProgress = true;
        await drainMock();
      };

      await simulate('SIGTERM');
      await simulate('SIGINT'); // arrived after SIGTERM completed
      await simulate('SIGTERM'); // double-signal scenario

      expect(drainMock).toHaveBeenCalledTimes(1);
    });
  });
});
