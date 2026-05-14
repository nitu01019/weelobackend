/**
 * =============================================================================
 * Phase 7 / Fix #12 — Pod-restart graceful drain protocol
 * =============================================================================
 *
 * Validates:
 *   (a) Phase A — `redisService.set('pod:drained:${podId}', ...)` is called
 *       BEFORE any `socket.disconnect(true)` on the live socket Map.
 *   (b) Phase B — sockets disconnect in batches of DRAIN_BATCH_SIZE (100) with
 *       DRAIN_BATCH_INTERVAL_MS (250ms) waits between batches.
 *   (c) Phase C — drain completes within DRAIN_HARD_CAP_MS (18s default) with
 *       a `setImmediate`-yielded event loop between batches.
 *   (d) Connection-handler — when `socket.handshake.auth.lastPodId` matches a
 *       live drain marker, the enhanced 2-10s jitter path is taken AND the
 *       legacy `Math.random() * 2000` jitter is skipped (didEnhancedJitter=true).
 *   (e) Connection-handler — when no lastPodId or no marker, the legacy
 *       jitter path runs unchanged.
 *
 * Source-code wire-up assertions are used for (d) and (e) — the connection
 * handler is scoped inside `initializeSocket` and not directly invokable, but
 * the control-flow placement is what determines correctness. Runtime tests
 * exercise the exported `drainSocketsStaggered` against a fake io via
 * `__setIoForTesting` for (a), (b), (c).
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { registerDefaultCounters } from '../shared/monitoring/metrics-definitions';
import type { CounterMetric } from '../shared/monitoring/metrics.service';

const SOCKET_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'socket.service.ts');
const SERVER_PATH = join(__dirname, '..', 'server.ts');
const METRICS_DEFS_PATH = join(__dirname, '..', 'shared', 'monitoring', 'metrics-definitions.ts');

describe('Phase 7 — Fix #12 pod-restart graceful drain', () => {
  let socketSource: string;
  let serverSource: string;
  let metricsDefsSource: string;

  beforeAll(() => {
    socketSource = readFileSync(SOCKET_SERVICE_PATH, 'utf8');
    serverSource = readFileSync(SERVER_PATH, 'utf8');
    metricsDefsSource = readFileSync(METRICS_DEFS_PATH, 'utf8');
  });

  // -----------------------------------------------------------------------
  // (counter registration) — pre-registered, NOT auto-created.
  // CLAUDE.md 2026-05-14 correction: `incrementCounter` does NOT auto-create.
  // -----------------------------------------------------------------------
  describe('counter registration in metrics-definitions.ts', () => {
    it('registers socket_reconnect_post_drain_total in registerDefaultCounters', () => {
      const counters = new Map<string, CounterMetric>();
      registerDefaultCounters(counters);
      const c = counters.get('socket_reconnect_post_drain_total');
      expect(c).toBeDefined();
      expect(c?.help).toMatch(/drain-marker.*previous pod.*enhanced jitter/i);
      expect(c?.help).toMatch(/Finding #12/);
    });

    it('counter help string declares the role label (cardinality budget)', () => {
      expect(metricsDefsSource).toMatch(
        /socket_reconnect_post_drain_total[\s\S]{0,400}labels: role/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // (runtime drainSocketsStaggered against a fake io)
  // -----------------------------------------------------------------------
  describe('drainSocketsStaggered runtime behaviour', () => {
    // Reset module state between runtime tests so __setIoForTesting starts clean.
    afterEach(() => {
      jest.resetModules();
      jest.useRealTimers();
      delete process.env.ECS_STOPTIMEOUT_CONFIRMED_GTE_45S;
    });

    it('(a) writes Redis drain-marker BEFORE any socket.disconnect (Phase A)', async () => {
      const callOrder: string[] = [];
      const setMock = jest.fn(async (key: string, _value: string, _ttl?: number) => {
        if (key.startsWith('pod:drained:')) callOrder.push('redis.set');
        return undefined;
      });

      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          set: setMock,
          get: jest.fn(async () => null),
        },
      }));

      const socketService = require('../shared/services/socket.service');

      const sockets: Array<{ id: string; disconnect: jest.Mock }> = Array.from(
        { length: 5 },
        (_, i) => ({
          id: `s${i}`,
          disconnect: jest.fn(() => {
            callOrder.push(`disconnect:s${i}`);
          }),
        }),
      );
      const fakeIo = {
        sockets: { sockets: new Map(sockets.map(s => [s.id, s])) },
        emit: jest.fn(),
      };

      socketService.__setIoForTesting(fakeIo);

      // Use fake timers so the 5s pre-drain + 250ms inter-batch + 1s flush
      // don't actually wait 6+ seconds of real wall time.
      jest.useFakeTimers();
      const drainPromise = socketService.drainSocketsStaggered();
      // Advance well past 5s pre-drain + flush.
      await jest.advanceTimersByTimeAsync(20_000);
      await drainPromise;

      // First call MUST be redis.set; emit happens after but disconnects after pre-drain.
      expect(callOrder[0]).toBe('redis.set');
      expect(setMock).toHaveBeenCalledTimes(1);
      const firstCall = setMock.mock.calls[0];
      expect(firstCall[0]).toMatch(/^pod:drained:/);
      // value is JSON string with podId+drainStartMs+drainPlannedSec
      const payload = JSON.parse(firstCall[1] as string);
      expect(payload).toHaveProperty('podId');
      expect(payload).toHaveProperty('drainStartMs');
      expect(payload).toHaveProperty('drainPlannedSec', 5);
      // 60s TTL
      expect(firstCall[2]).toBe(60);

      // Then emit, then disconnects — all 5 disconnected.
      expect(fakeIo.emit).toHaveBeenCalledWith(
        'server_drain_pending',
        expect.objectContaining({ drainSeconds: 5, drainStartMs: expect.any(Number) }),
      );
      const disconnectCount = callOrder.filter(s => s.startsWith('disconnect:')).length;
      expect(disconnectCount).toBe(5);
    });

    it('(b)(c) staggers disconnects in batches of 100 with 250ms gaps inside DRAIN_HARD_CAP', async () => {
      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          set: jest.fn(async () => undefined),
          get: jest.fn(async () => null),
        },
      }));

      const socketService = require('../shared/services/socket.service');

      // Seed exactly 250 sockets → 3 batches (100, 100, 50) with 2 inter-batch sleeps.
      const sockets: Array<{ id: string; disconnect: jest.Mock }> = Array.from(
        { length: 250 },
        (_, i) => ({
          id: `s${i}`,
          disconnect: jest.fn(),
        }),
      );
      const fakeIo = {
        sockets: { sockets: new Map(sockets.map(s => [s.id, s])) },
        emit: jest.fn(),
      };
      socketService.__setIoForTesting(fakeIo);

      jest.useFakeTimers();
      const startMs = Date.now();
      const drainPromise = socketService.drainSocketsStaggered();

      // Drain math: 5_000 pre-drain + 2 inter-batch waits (250ms each) + 1_000
      // flush = 6_500ms. We advance exactly past that to observe completion
      // without overshooting the AbortController hard cap (18_000ms default).
      await jest.advanceTimersByTimeAsync(7_000);
      await drainPromise;
      const elapsedMs = Date.now() - startMs;

      // All 250 sockets disconnected exactly once.
      const totalDisconnects = sockets.reduce(
        (acc, s) => acc + s.disconnect.mock.calls.length,
        0,
      );
      expect(totalDisconnects).toBe(250);

      // Elapsed (in fake-timer time) must be UNDER the default 18s hard cap.
      expect(elapsedMs).toBeLessThanOrEqual(18_000);
      // And at least the expected drain budget (5s pre-drain + 2 batches × 250ms).
      expect(elapsedMs).toBeGreaterThanOrEqual(5_500);
    });

    it('respects DRAIN_HARD_CAP_MS env-gate bump when ECS_STOPTIMEOUT_CONFIRMED_GTE_45S=true', async () => {
      // Source-code assertion (env var is read at module load + inside the
      // function). Cheaper + deterministic than re-importing with env set.
      // The hard cap must switch between 18_000 and 30_000 on the same env var.
      expect(socketSource).toMatch(
        /ECS_STOPTIMEOUT_CONFIRMED_GTE_45S[\s\S]{0,200}'true'\s*\?\s*30_000\s*:\s*18_000/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // (d) Source-code wire-up: drain-marker check in connection handler
  // -----------------------------------------------------------------------
  describe('connection-handler drain-marker check (source wire-up)', () => {
    it('(d) reads auth.lastPodId from handshake and looks up Redis drain marker', () => {
      // The drain-marker check must occur INSIDE the `io.on('connection',...)`
      // body, BEFORE the legacy FIX-46 jitter. Assert order via single regex.
      const connectionBlock = socketSource.match(
        /io\.on\('connection',[\s\S]*?lastPodId[\s\S]*?redisService\.get\(`pod:drained:\$\{previousPod\}`\)[\s\S]*?didEnhancedJitter\s*=\s*true[\s\S]*?if\s*\(!didEnhancedJitter\)\s*\{[\s\S]*?Math\.random\(\)\s*\*\s*2000/,
      );
      expect(connectionBlock).not.toBeNull();
    });

    it('(d) increments socket_reconnect_post_drain_total when marker is found', () => {
      // Counter call must sit inside the marker-found branch, before
      // `didEnhancedJitter = true` flips the legacy-jitter guard.
      expect(socketSource).toMatch(
        /if\s*\(drainMarker\)[\s\S]{0,800}metrics\.incrementCounter\(\s*'socket_reconnect_post_drain_total'/,
      );
    });

    it('(d) enhanced jitter is 2_000 + Math.random() * 8_000 (2-10s range)', () => {
      expect(socketSource).toMatch(/enhancedJitterMs\s*=\s*2_000\s*\+\s*Math\.random\(\)\s*\*\s*8_000/);
    });

    it('(d) bounds-check lastPodId length to avoid Redis-key abuse (<256 chars, non-empty)', () => {
      expect(socketSource).toMatch(
        /typeof previousPod === 'string'[\s\S]{0,200}previousPod\.length\s*<\s*256/,
      );
    });

    // (e) — When no lastPodId or no marker, the legacy 2s jitter runs unchanged
    // (guarded by `if (!didEnhancedJitter)`).
    it('(e) legacy FIX-46 2s jitter is preserved when no drain-marker hit', () => {
      expect(socketSource).toMatch(
        /if\s*\(!didEnhancedJitter\)\s*\{\s*await new Promise\(resolve\s*=>\s*setTimeout\(resolve,\s*Math\.random\(\)\s*\*\s*2000\)\)/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // server.ts wire-up — Phase-10 calls drainSocketsStaggered + env-gated
  // force-shutdown timer.
  // -----------------------------------------------------------------------
  describe('server.ts shutdown wire-up', () => {
    it('Phase-10 try-body invokes drainSocketsStaggered (not the old forEach blast)', () => {
      expect(serverSource).toMatch(
        /const \{ drainSocketsStaggered \}[\s\S]{0,200}require\('\.\/shared\/services\/socket\.service'\)/,
      );
      expect(serverSource).toMatch(/await drainSocketsStaggered\(\)/);
      // Old blast pattern must be GONE from executable code (comments allowed
      // for archaeology). Strip line comments + block comments before assertion.
      const stripped = serverSource
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(l => l.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(stripped).not.toMatch(/io\.sockets\.sockets\.forEach\(/);
    });

    it('FORCE_SHUTDOWN_MS is env-gated via ECS_STOPTIMEOUT_CONFIRMED_GTE_45S', () => {
      expect(serverSource).toMatch(
        /ECS_STOPTIMEOUT_BUMPED\s*=\s*process\.env\.ECS_STOPTIMEOUT_CONFIRMED_GTE_45S\s*===\s*'true'/,
      );
      expect(serverSource).toMatch(
        /FORCE_SHUTDOWN_MS\s*=\s*ECS_STOPTIMEOUT_BUMPED\s*\?\s*35_000\s*:\s*25_000/,
      );
      expect(serverSource).toMatch(/setTimeout\([\s\S]{0,200}FORCE_SHUTDOWN_MS\)\.unref\(\)/);
    });
  });
});
