/**
 * P1 — T1.6 process-metric registration tests.
 *
 * Verifies the two process metrics owned by T1.6 are pre-registered
 * (no auto-create warn on first use) and surface in the Prometheus
 * export. Prevents silent drift of the infra/naming contract between
 * metrics.service.ts and metrics-definitions.ts.
 */

import { metrics } from '../shared/monitoring/metrics.service';
import { LATENCY_BUCKETS } from '../shared/monitoring/metrics-definitions';
import { logger } from '../shared/services/logger.service';

describe('P1-T1.6 — process metrics registration', () => {
    it('server_boot_scan_ms histogram is pre-registered (no warn on first observe)', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        metrics.observeHistogram('server_boot_scan_ms', 42);
        const warnedForThisMetric = warnSpy.mock.calls.some((call: unknown[]) => {
            const first = call[0];
            return typeof first === 'string' && first.includes('server_boot_scan_ms');
        });
        expect(warnedForThisMetric).toBe(false);
        warnSpy.mockRestore();
    });

    it('phase1_landed_commit_sha gauge is pre-registered and settable', () => {
        metrics.setGauge('phase1_landed_commit_sha', 1);
        const json = metrics.getMetricsJSON();
        const gauges = json.gauges as Record<string, number>;
        expect(gauges).toHaveProperty('phase1_landed_commit_sha');
        expect(gauges.phase1_landed_commit_sha).toBe(1);
    });

    it('both process metrics appear in Prometheus export', () => {
        const output = metrics.getPrometheusMetrics();
        expect(output).toContain('server_boot_scan_ms');
        expect(output).toContain('phase1_landed_commit_sha');
    });

    it('LATENCY_BUCKETS is exported and non-empty', () => {
        expect(Array.isArray(LATENCY_BUCKETS)).toBe(true);
        expect(LATENCY_BUCKETS.length).toBeGreaterThan(0);
        expect(LATENCY_BUCKETS[0]).toBeLessThan(LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1]);
    });
});
