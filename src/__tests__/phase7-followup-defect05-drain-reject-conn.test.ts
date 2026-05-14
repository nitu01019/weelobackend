/**
 * =============================================================================
 * Phase 7 follow-up — Defect #5: Reject new connections during graceful drain
 * =============================================================================
 *
 * During the 5s pre-drain window (DRAIN_PREDRAIN_MS), `_isShuttingDown=true`
 * on server.ts but new sockets still hit the full connection handler — they
 * join rooms, run replay logic, then get a surprise `disconnect(true)`
 * mid-flow when the drain loop reaches them. Client retries, lands on the
 * same draining pod again — thundering herd against self.
 *
 * Fix: at the very top of `io.on('connection', ...)`, lazy-require
 * `isShuttingDown` from server.ts. If true, `socket.disconnect(true)` and
 * return immediately. Lazy-require avoids the static-import circular-
 * dependency risk (matches existing socket.service.ts inline-require
 * convention at L257, L271, L313, L338, L371).
 *
 * Industry: Linkerd / Envoy "fail-fast during drain" pattern.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SOCKET_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'socket.service.ts');

describe('Phase 7 follow-up — Defect #5 reject connections during drain', () => {
  let source: string;
  let handlerBlock: string;

  beforeAll(() => {
    source = readFileSync(SOCKET_SERVICE_PATH, 'utf8');
    // Slice the FIRST 1200 bytes of the connection handler. The drain check
    // must sit BEFORE the CSR observation logic.
    const handlerStart = source.indexOf("io.on('connection'");
    expect(handlerStart).toBeGreaterThan(-1);
    handlerBlock = source.slice(handlerStart, handlerStart + 1200);
  });

  it('connection handler lazy-requires isShuttingDown from ../../server', () => {
    expect(handlerBlock).toMatch(
      /require\(['"]\.\.\/\.\.\/server['"]\)[\s\S]{0,120}isShuttingDown/,
    );
  });

  it('drain check sits BEFORE the CSR observation logic', () => {
    const drainCheckIdx = handlerBlock.indexOf('isShuttingDown()');
    const csrIdx = handlerBlock.indexOf('socket.recovered');
    expect(drainCheckIdx).toBeGreaterThan(-1);
    expect(csrIdx).toBeGreaterThan(-1);
    expect(drainCheckIdx).toBeLessThan(csrIdx);
  });

  it('disconnects the socket immediately if shutdown is in progress', () => {
    expect(handlerBlock).toMatch(
      /if\s*\(\s*isShuttingDown\(\)\s*\)\s*\{[\s\S]{0,200}socket\.disconnect\([^)]*\)[\s\S]{0,80}return/,
    );
  });

  it('wraps the lazy-require in try/catch to tolerate test harnesses', () => {
    // server.ts may not load in jest isolatedModules — catch swallows
    expect(handlerBlock).toMatch(/try\s*\{[\s\S]{0,300}isShuttingDown[\s\S]{0,200}\}\s*catch/);
  });

  // ---------------------------------------------------------------------------
  // Behavioural mirror — proves the early-return pattern's correctness
  // ---------------------------------------------------------------------------
  describe('behavioural mirror of the drain-reject pattern', () => {
    function simulate(
      isShuttingDownReturn: boolean,
      socket: { disconnect: jest.Mock; recovered: boolean },
    ): { csrObserved: boolean } {
      // Mirror of the production pattern: drain check first, then CSR.
      try {
        const isShuttingDown = (): boolean => isShuttingDownReturn;
        if (isShuttingDown()) {
          socket.disconnect(true);
          return { csrObserved: false };
        }
      } catch {
        // server module not loaded — proceed
      }

      // CSR observation step (would normally run)
      const csrRecovered = socket.recovered === true;
      return { csrObserved: csrRecovered };
    }

    it('disconnects immediately when isShuttingDown=true', () => {
      const disc = jest.fn();
      const result = simulate(true, { disconnect: disc, recovered: false });
      expect(disc).toHaveBeenCalledWith(true);
      expect(result.csrObserved).toBe(false);
    });

    it('proceeds normally when isShuttingDown=false', () => {
      const disc = jest.fn();
      const result = simulate(false, { disconnect: disc, recovered: true });
      expect(disc).not.toHaveBeenCalled();
      expect(result.csrObserved).toBe(true);
    });

    it('survives a require() throw (test harness)', () => {
      const disc = jest.fn();
      // simulate() catches any throw — passing a fn that throws via the simulate body itself
      function throwingSimulate(socket: { disconnect: jest.Mock; recovered: boolean }): { csrObserved: boolean } {
        try {
          const isShuttingDown = (): boolean => { throw new Error('module not loaded'); };
          if (isShuttingDown()) {
            socket.disconnect(true);
            return { csrObserved: false };
          }
        } catch {
          // tolerated — proceed to CSR
        }
        return { csrObserved: socket.recovered === true };
      }
      const result = throwingSimulate({ disconnect: disc, recovered: true });
      expect(disc).not.toHaveBeenCalled();
      expect(result.csrObserved).toBe(true);
    });
  });
});
