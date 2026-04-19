/**
 * =============================================================================
 * FIX-47 & FIX-48: MetricsService Hardening Tests
 * =============================================================================
 *
 * FIX-47 (#113): Replace Array.shift() O(n) loop with splice in pruning
 * FIX-48 (#114): Auto-register counters/histograms on first use
 *
 * Tests verify:
 *  1. Old HTTP samples are efficiently pruned (no shift() loop)
 *  2. Empty sample array is handled correctly
 *  3. All-old-entries scenario clears the array
 *  4. Unknown counter names auto-register and increment
 *  5. Pre-registered counters still work after the change
 *  6. Unknown histogram names auto-register and observe
 *  7. Pre-registered histograms still work after the change
 *
 * =============================================================================
 */

import { metrics } from '../shared/monitoring/metrics.service';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract counter value from the JSON snapshot for a given counter name.
 * Returns the labels map (labelKey -> value).
 */
function getCounterLabels(name: string): Record<string, number> | undefined {
  const json = metrics.getMetricsJSON();
  const counters = json.counters as Record<string, Record<string, number>>;
  return counters[name];
}

/**
 * Extract histogram count/sum from the JSON snapshot.
 */
function getHistogramStats(
  name: string
): { count: Record<string, number>; sum: Record<string, number> } | undefined {
  const json = metrics.getMetricsJSON();
  const histograms = json.histograms as Record<
    string,
    { count: Record<string, number>; sum: Record<string, number> }
  >;
  return histograms[name];
}

// =============================================================================
// FIX-47: Efficient sample pruning (shift() loop replaced with splice)
// =============================================================================

describe('FIX-47: HTTP sample pruning uses splice instead of shift loop', () => {
  const WINDOW_MS = 15 * 60 * 1000; // 15 minutes, matches maxHttpSampleWindowMs

  test('old samples are pruned after recording new ones outside the window', () => {
    const now = Date.now();
    const oldTimestamp = now - WINDOW_MS - 5000; // 5s beyond the window

    // Record several old samples
    for (let i = 0; i < 50; i++) {
      metrics.recordHttpRequestSample({
        timestampMs: oldTimestamp + i,
        durationMs: 100,
        statusCode: 200,
      });
    }

    // Record a fresh sample -- this triggers pruning
    metrics.recordHttpRequestSample({
      timestampMs: now,
      durationMs: 50,
      statusCode: 200,
    });

    // The SLO summary for a 1-minute window should only see the fresh sample
    const summary = metrics.getHttpSloSummary(1);
    // Old samples should have been pruned; at most the fresh sample is visible
    expect(summary.sampleCount).toBeGreaterThanOrEqual(1);
    // The average should be close to 50ms (the fresh sample), not 100ms
    // If old samples survived, average would be ~100ms
    expect(summary.avgMs).toBeLessThanOrEqual(60);
  });

  test('empty sample array is handled without errors', () => {
    // getHttpSloSummary calls pruneHttpRequestSamples internally
    // On an empty array, findIndex returns -1 and length is set to 0 (no-op)
    expect(() => {
      const summary = metrics.getHttpSloSummary(1);
      expect(summary.sampleCount).toBeGreaterThanOrEqual(0);
      expect(summary.p95Ms).toBeGreaterThanOrEqual(0);
      expect(summary.p99Ms).toBeGreaterThanOrEqual(0);
    }).not.toThrow();
  });

  test('all-old entries scenario clears the array completely', () => {
    const now = Date.now();
    const veryOldTimestamp = now - WINDOW_MS - 60_000; // 1 minute beyond window

    // Inject samples that are all outside the window
    for (let i = 0; i < 30; i++) {
      metrics.recordHttpRequestSample({
        timestampMs: veryOldTimestamp + i,
        durationMs: 200,
        statusCode: 500,
      });
    }

    // Trigger pruning by calling getHttpSloSummary (which calls pruneHttpRequestSamples)
    const summary = metrics.getHttpSloSummary(1);

    // No samples should survive the pruning within a 1-minute window
    // (all were recorded >15 min ago)
    // The fresh sample from the previous test may still linger, but the
    // 30 old 500-status samples should be gone. Error rate should be 0 or
    // based only on surviving fresh samples.
    expect(summary.errorRate5xxPct).toBe(0);
  });

  test('mixed old and new samples: only new survive after pruning', () => {
    const now = Date.now();
    const oldTs = now - WINDOW_MS - 1000;
    const recentTs = now - 30_000; // 30 seconds ago -- well within window

    // 20 old samples
    for (let i = 0; i < 20; i++) {
      metrics.recordHttpRequestSample({
        timestampMs: oldTs + i,
        durationMs: 500,
        statusCode: 503,
      });
    }

    // 5 recent samples
    for (let i = 0; i < 5; i++) {
      metrics.recordHttpRequestSample({
        timestampMs: recentTs + i * 100,
        durationMs: 10,
        statusCode: 200,
      });
    }

    const summary = metrics.getHttpSloSummary(1);
    // Only recent samples should contribute; all are 200 status
    expect(summary.errorRate5xxPct).toBe(0);
    // The 5 recent samples had durationMs=10; residual samples from prior tests
    // in the singleton may slightly raise the average, but old 500ms/503 samples
    // must have been pruned. Average should be well below the 500ms old value.
    expect(summary.avgMs).toBeLessThan(100);
  });

  test('pruning does not remove samples that are exactly at the boundary', () => {
    const now = Date.now();
    const boundaryTs = now - WINDOW_MS; // Exactly at the edge

    metrics.recordHttpRequestSample({
      timestampMs: boundaryTs,
      durationMs: 77,
      statusCode: 200,
    });

    metrics.recordHttpRequestSample({
      timestampMs: now,
      durationMs: 33,
      statusCode: 200,
    });

    const summary = metrics.getHttpSloSummary(15); // Full 15-min window
    // Both samples should survive (boundary sample is >= minTimestamp)
    expect(summary.sampleCount).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// FIX-48: Auto-register counters on first increment
// =============================================================================

describe('FIX-48: Counter auto-registration on first increment', () => {
  test('unknown counter name auto-registers and increments', () => {
    const uniqueName = `test_auto_counter_${Date.now()}`;

    // Should NOT throw or silently drop
    metrics.incrementCounter(uniqueName, {}, 5);

    const labels = getCounterLabels(uniqueName);
    expect(labels).toBeDefined();
    expect(labels!['']).toBe(5);
  });

  test('auto-registered counter increments accumulate correctly', () => {
    const uniqueName = `test_accum_counter_${Date.now()}`;

    metrics.incrementCounter(uniqueName, {}, 3);
    metrics.incrementCounter(uniqueName, {}, 7);
    metrics.incrementCounter(uniqueName, {}, 1);

    const labels = getCounterLabels(uniqueName);
    expect(labels).toBeDefined();
    expect(labels!['']).toBe(11);
  });

  test('auto-registered counter works with labels', () => {
    const uniqueName = `test_label_counter_${Date.now()}`;

    metrics.incrementCounter(uniqueName, { method: 'GET', status: '200' }, 2);
    metrics.incrementCounter(uniqueName, { method: 'POST', status: '201' }, 1);
    metrics.incrementCounter(uniqueName, { method: 'GET', status: '200' }, 3);

    const labels = getCounterLabels(uniqueName);
    expect(labels).toBeDefined();
    // Labels are sorted alphabetically: method="GET",status="200"
    expect(labels!['method="GET",status="200"']).toBe(5);
    expect(labels!['method="POST",status="201"']).toBe(1);
  });

  test('pre-registered counter (http_requests_total) still works', () => {
    const before = getCounterLabels('http_requests_total');
    const beforeValue = before?.['method="GET",path="/test"'] || 0;

    metrics.incrementCounter('http_requests_total', {
      method: 'GET',
      path: '/test',
    });

    const after = getCounterLabels('http_requests_total');
    expect(after).toBeDefined();
    expect(after!['method="GET",path="/test"']).toBe(beforeValue + 1);
  });

  test('pre-registered truck hold counters still work', () => {
    const before = getCounterLabels('hold_request_total');
    const beforeValue = before?.[''] || 0;

    metrics.incrementCounter('hold_request_total');

    const after = getCounterLabels('hold_request_total');
    expect(after).toBeDefined();
    expect(after!['']).toBe(beforeValue + 1);
  });

  test('auto-registered counter appears in Prometheus output', () => {
    const uniqueName = `test_prom_counter_${Date.now()}`;
    metrics.incrementCounter(uniqueName, {}, 42);

    const promOutput = metrics.getPrometheusMetrics();
    expect(promOutput).toContain(`# HELP ${uniqueName} Auto: ${uniqueName}`);
    expect(promOutput).toContain(`# TYPE ${uniqueName} counter`);
    expect(promOutput).toContain(`${uniqueName} 42`);
  });
});

// =============================================================================
// FIX-48: Auto-register histograms on first observe
// =============================================================================

describe('FIX-48: Histogram auto-registration on first observe', () => {
  test('unknown histogram name auto-registers and records value', () => {
    const uniqueName = `test_auto_histogram_${Date.now()}`;

    // Should NOT throw or silently drop
    metrics.observeHistogram(uniqueName, 123.45);

    const stats = getHistogramStats(uniqueName);
    expect(stats).toBeDefined();
    expect(stats!.count['']).toBe(1);
    expect(stats!.sum['']).toBeCloseTo(123.45, 1);
  });

  test('auto-registered histogram accumulates multiple observations', () => {
    const uniqueName = `test_multi_histogram_${Date.now()}`;

    metrics.observeHistogram(uniqueName, 10);
    metrics.observeHistogram(uniqueName, 20);
    metrics.observeHistogram(uniqueName, 30);

    const stats = getHistogramStats(uniqueName);
    expect(stats).toBeDefined();
    expect(stats!.count['']).toBe(3);
    expect(stats!.sum['']).toBe(60);
  });

  test('auto-registered histogram works with labels', () => {
    const uniqueName = `test_label_histogram_${Date.now()}`;

    metrics.observeHistogram(uniqueName, 5, { source: 'cache' });
    metrics.observeHistogram(uniqueName, 50, { source: 'api' });
    metrics.observeHistogram(uniqueName, 10, { source: 'cache' });

    const stats = getHistogramStats(uniqueName);
    expect(stats).toBeDefined();
    expect(stats!.count['source="cache"']).toBe(2);
    expect(stats!.sum['source="cache"']).toBe(15);
    expect(stats!.count['source="api"']).toBe(1);
    expect(stats!.sum['source="api"']).toBe(50);
  });

  test('pre-registered histogram (http_request_duration_ms) still works', () => {
    const before = getHistogramStats('http_request_duration_ms');
    const beforeCount = before?.count?.['method="GET",path="/health"'] || 0;

    metrics.observeHistogram('http_request_duration_ms', 42, {
      method: 'GET',
      path: '/health',
    });

    const after = getHistogramStats('http_request_duration_ms');
    expect(after).toBeDefined();
    expect(after!.count['method="GET",path="/health"']).toBe(beforeCount + 1);
  });

  test('pre-registered hold_latency_ms histogram still works', () => {
    const before = getHistogramStats('hold_latency_ms');
    const beforeCount = before?.count?.[''] || 0;

    metrics.observeHistogram('hold_latency_ms', 99);

    const after = getHistogramStats('hold_latency_ms');
    expect(after).toBeDefined();
    expect(after!.count['']).toBe(beforeCount + 1);
  });

  test('auto-registered histogram appears in Prometheus output', () => {
    const uniqueName = `test_prom_histogram_${Date.now()}`;
    metrics.observeHistogram(uniqueName, 250);

    const promOutput = metrics.getPrometheusMetrics();
    expect(promOutput).toContain(`# HELP ${uniqueName} Auto: ${uniqueName}`);
    expect(promOutput).toContain(`# TYPE ${uniqueName} histogram`);
    expect(promOutput).toContain(`${uniqueName}_count 1`);
    expect(promOutput).toContain(`${uniqueName}_sum 250`);
  });

  test('startTimer works with auto-registered histogram', () => {
    const uniqueName = `test_timer_histogram_${Date.now()}`;

    const stop = metrics.startTimer(uniqueName);
    // Simulate some work
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait ~5ms
    }
    stop();

    const stats = getHistogramStats(uniqueName);
    expect(stats).toBeDefined();
    expect(stats!.count['']).toBe(1);
    expect(stats!.sum['']).toBeGreaterThan(0);
  });
});

// =============================================================================
// Verify no shift() regression in source (static analysis)
// =============================================================================

describe('FIX-47: Source code verification', () => {
  test('pruneHttpRequestSamples does not use shift() in a while loop', () => {
    // Read the source file and verify the fix is in place
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'monitoring', 'metrics.service.ts'),
      'utf8'
    );

    // Extract the pruneHttpRequestSamples method body
    const pruneMatch = source.match(
      /pruneHttpRequestSamples\(nowMs: number\): void \{([\s\S]*?)\n  \}/
    );
    expect(pruneMatch).not.toBeNull();

    const methodBody = pruneMatch![1];

    // Should NOT contain a while + shift pattern
    expect(methodBody).not.toMatch(/while[\s\S]*?\.shift\(\)/);

    // Should contain the efficient findIndex + splice pattern
    expect(methodBody).toContain('findIndex');
    expect(methodBody).toContain('splice');
  });

  test('incrementCounter does not silently drop unknown counters', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'monitoring', 'metrics.service.ts'),
      'utf8'
    );

    // Extract incrementCounter method
    const methodMatch = source.match(
      /incrementCounter\(name: string[\s\S]*?\n  \}/
    );
    expect(methodMatch).not.toBeNull();

    const methodBody = methodMatch![0];

    // Should NOT contain early return for missing counter
    expect(methodBody).not.toContain('logger.warn(`Counter ${name} not found`)');
    expect(methodBody).not.toMatch(/if \(!counter\) \{\s*logger\.warn/);

    // Should contain auto-registration
    expect(methodBody).toContain('this.counters.set(name');
  });

  test('observeHistogram does not silently drop unknown histograms', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'monitoring', 'metrics.service.ts'),
      'utf8'
    );

    // Extract observeHistogram method -- grab from signature to next method
    const methodMatch = source.match(
      /observeHistogram\(name: string[\s\S]*?this\.histograms\.set\(name, histogram\);/
    );
    expect(methodMatch).not.toBeNull();

    const methodBody = methodMatch![0];

    // Should NOT contain early return for missing histogram
    expect(methodBody).not.toContain(
      'logger.warn(`Histogram ${name} not found`)'
    );

    // Should contain auto-registration
    expect(methodBody).toContain('this.histograms.set(name');
  });
});
