/**
 * =============================================================================
 * Fix #1 (PART A) — In-process EMF emitter for `broadcast_queue_depth`
 * =============================================================================
 *
 * RED expectations:
 *   (a) FF_EMF_INPROCESS_FALLBACK=true → startEmfBroadcastDepthBridge
 *       registers a setInterval; stopEmfBroadcastDepthBridge clears it.
 *   (b) FF unset/false → start is a no-op (no interval registered).
 *   (c) Idempotent start — calling twice does not register a second interval.
 *   (d) Emits valid EMF JSON to process.stdout (CloudWatchMetrics shape +
 *       broadcast_queue_depth + service).
 *   (e) EMF_BRIDGE_INTERVAL_MS is clamped to >= 10 000 ms.
 *   (f) Reads metrics.getGaugeValue('broadcast_queue_depth'); defaults to 0
 *       when undefined.
 *   (g) When metrics.getGaugeValue throws, logs warn and continues (the
 *       interval keeps running on subsequent ticks).
 * =============================================================================
 */

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const getGaugeValueMock = jest.fn<number | undefined, [string]>(() => 0);

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    getGaugeValue: (name: string) => getGaugeValueMock(name),
  },
  metricsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { logger } from '../shared/services/logger.service';

/**
 * Always import the bridge through jest.isolateModules so each test gets a
 * fresh module-level `emfBridgeInterval` singleton. Mirrors the pattern used
 * by other Phase-4 tests in this repo.
 */
function loadBridge() {
  let mod!: typeof import('../shared/monitoring/emf-bridge');
  jest.isolateModules(() => {
    mod = require('../shared/monitoring/emf-bridge');
  });
  return mod;
}

describe('Phase 4 — Fix #1 EMF bridge (in-process fallback)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    getGaugeValueMock.mockReset();
    getGaugeValueMock.mockReturnValue(0);
    (logger.warn as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
    delete process.env.FF_EMF_INPROCESS_FALLBACK;
    delete process.env.EMF_BRIDGE_INTERVAL_MS;
    delete process.env.CW_NAMESPACE;
    delete process.env.ECS_SERVICE;
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    jest.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it('(a) FF on → start registers setInterval; stop clears it', () => {
    process.env.FF_EMF_INPROCESS_FALLBACK = 'true';
    const bridge = loadBridge();

    bridge.startEmfBroadcastDepthBridge();

    // Advance just enough to fire the first interval tick.
    jest.advanceTimersByTime(10_000);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    bridge.stopEmfBroadcastDepthBridge();

    // After stop, no further emissions.
    stdoutSpy.mockClear();
    jest.advanceTimersByTime(30_000);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('(b) FF unset/false → start is a no-op (no interval registered)', () => {
    const bridge = loadBridge();

    bridge.startEmfBroadcastDepthBridge();
    jest.advanceTimersByTime(60_000);

    expect(stdoutSpy).not.toHaveBeenCalled();

    process.env.FF_EMF_INPROCESS_FALLBACK = 'false';
    const bridge2 = loadBridge();
    bridge2.startEmfBroadcastDepthBridge();
    jest.advanceTimersByTime(60_000);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('(c) idempotent start — second call does not register a second interval', () => {
    process.env.FF_EMF_INPROCESS_FALLBACK = 'true';
    const bridge = loadBridge();

    bridge.startEmfBroadcastDepthBridge();
    bridge.startEmfBroadcastDepthBridge();

    // One interval → exactly one emission per tick.
    jest.advanceTimersByTime(10_000);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    bridge.stopEmfBroadcastDepthBridge();
  });

  it('(d) emits valid EMF JSON to stdout (CloudWatchMetrics shape + service + depth)', () => {
    process.env.FF_EMF_INPROCESS_FALLBACK = 'true';
    process.env.CW_NAMESPACE = 'Weelo/Test';
    process.env.ECS_SERVICE = 'weelo-test-service';
    getGaugeValueMock.mockReturnValue(4242);

    const bridge = loadBridge();
    bridge.startEmfBroadcastDepthBridge();
    jest.advanceTimersByTime(10_000);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = String(stdoutSpy.mock.calls[0][0] as string);
    expect(written.endsWith('\n')).toBe(true);

    const payload = JSON.parse(written.trim());
    expect(payload._aws).toBeDefined();
    expect(typeof payload._aws.Timestamp).toBe('number');
    expect(Array.isArray(payload._aws.CloudWatchMetrics)).toBe(true);
    expect(payload._aws.CloudWatchMetrics[0].Namespace).toBe('Weelo/Test');
    expect(payload._aws.CloudWatchMetrics[0].Dimensions).toEqual([['service']]);
    expect(payload._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: 'broadcast_queue_depth', Unit: 'Count' },
    ]);
    expect(payload.service).toBe('weelo-test-service');
    expect(payload.broadcast_queue_depth).toBe(4242);

    bridge.stopEmfBroadcastDepthBridge();
  });

  it('(e) EMF_BRIDGE_INTERVAL_MS is clamped to >= 10 000 ms', () => {
    process.env.FF_EMF_INPROCESS_FALLBACK = 'true';
    process.env.EMF_BRIDGE_INTERVAL_MS = '500'; // < 10 000, must be clamped up

    const bridge = loadBridge();
    bridge.startEmfBroadcastDepthBridge();

    // Should NOT fire at 500ms.
    jest.advanceTimersByTime(500);
    expect(stdoutSpy).not.toHaveBeenCalled();

    // Should NOT fire at 5 000ms (still below floor).
    jest.advanceTimersByTime(4_500);
    expect(stdoutSpy).not.toHaveBeenCalled();

    // Fires at 10 000ms.
    jest.advanceTimersByTime(5_000);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    bridge.stopEmfBroadcastDepthBridge();
  });

  it('(f) reads getGaugeValue("broadcast_queue_depth"); defaults to 0 when undefined', () => {
    process.env.FF_EMF_INPROCESS_FALLBACK = 'true';
    getGaugeValueMock.mockReturnValue(undefined);

    const bridge = loadBridge();
    bridge.startEmfBroadcastDepthBridge();
    jest.advanceTimersByTime(10_000);

    expect(getGaugeValueMock).toHaveBeenCalledWith('broadcast_queue_depth');
    const written = String(stdoutSpy.mock.calls[0][0] as string);
    const payload = JSON.parse(written.trim());
    expect(payload.broadcast_queue_depth).toBe(0);

    bridge.stopEmfBroadcastDepthBridge();
  });

  it('(g) getGaugeValue throws → logs warn and continues (next tick fires)', () => {
    process.env.FF_EMF_INPROCESS_FALLBACK = 'true';
    getGaugeValueMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    getGaugeValueMock.mockReturnValue(7);

    const bridge = loadBridge();
    bridge.startEmfBroadcastDepthBridge();

    // First tick — throws → no stdout write, warn logged.
    jest.advanceTimersByTime(10_000);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock).mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('[EmfBridge] emit failed'),
    )).toBe(true);

    // Second tick — recovers, emits.
    jest.advanceTimersByTime(10_000);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(stdoutSpy.mock.calls[0][0] as string).trim());
    expect(payload.broadcast_queue_depth).toBe(7);

    bridge.stopEmfBroadcastDepthBridge();
  });
});
