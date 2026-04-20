/**
 * Phase 6 — Observability: Unit Tests
 *
 * Tests cover:
 * 1. New metrics are pre-registered in MetricsService
 * 2. Histogram observations work for broadcast metrics
 * 3. Counter increments work for delivery metrics
 * 4. Prometheus export includes new metrics
 */

import { metrics } from '../shared/monitoring/metrics.service';

// ============================================================================
// METRIC REGISTRATION VERIFICATION
// ============================================================================

describe('Phase 6: Dispatch Pipeline Metrics Registration', () => {
    it('broadcast_candidate_lookup_ms histogram is registered', () => {
        // Should not warn "Histogram not found"
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.observeHistogram('broadcast_candidate_lookup_ms', 12, {
            algorithm: 'h3', step: '0'
        });
        // If registered, no warning is emitted
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('broadcast_candidate_lookup_ms not found')
        );
        spy.mockRestore();
    });

    it('broadcast_scoring_ms histogram is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.observeHistogram('broadcast_scoring_ms', 45, {
            source: 'directions_api'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('broadcast_scoring_ms not found')
        );
        spy.mockRestore();
    });

    it('broadcast_end_to_end_ms histogram is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.observeHistogram('broadcast_end_to_end_ms', 350, {
            vehicleType: 'truck'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('broadcast_end_to_end_ms not found')
        );
        spy.mockRestore();
    });

    it('broadcast_delivery_latency_ms histogram is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.observeHistogram('broadcast_delivery_latency_ms', 22, {
            channel: 'socket'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('broadcast_delivery_latency_ms not found')
        );
        spy.mockRestore();
    });
});

describe('Phase 6: Delivery Channel Metrics Registration', () => {
    it('broadcast_candidates_found counter is registered', () => {
        // incrementCounter on a non-existent counter logs a warning
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('broadcast_candidates_found', {
            vehicleType: 'truck', step: '0'
        }, 5);
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Counter broadcast_candidates_found not found')
        );
        spy.mockRestore();
    });

    it('broadcast_fanout_total counter is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('broadcast_fanout_total', {
            vehicleType: 'truck'
        }, 10);
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Counter broadcast_fanout_total not found')
        );
        spy.mockRestore();
    });

    it('broadcast_delivery_enqueued counter is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('broadcast_delivery_enqueued', {
            channel: 'socket', priority: '0'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Counter broadcast_delivery_enqueued not found')
        );
        spy.mockRestore();
    });

    it('broadcast_delivery_delivered counter is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('broadcast_delivery_delivered', {
            channel: 'fcm'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Counter broadcast_delivery_delivered not found')
        );
        spy.mockRestore();
    });

    it('broadcast_delivery_failed counter is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('broadcast_delivery_failed', {
            channel: 'socket', reason: 'timeout'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Counter broadcast_delivery_failed not found')
        );
        spy.mockRestore();
    });

    it('broadcast_skipped_no_available counter is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('broadcast_skipped_no_available', {
            vehicleType: 'truck'
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Counter broadcast_skipped_no_available not found')
        );
        spy.mockRestore();
    });
});

// ============================================================================
// PROMETHEUS EXPORT
// ============================================================================

describe('Phase 6: Prometheus Export', () => {
    it('exports new metrics in Prometheus format', () => {
        const output = metrics.getPrometheusMetrics();
        expect(output).toContain('broadcast_candidate_lookup_ms');
        expect(output).toContain('broadcast_scoring_ms');
        expect(output).toContain('broadcast_end_to_end_ms');
        expect(output).toContain('broadcast_delivery_latency_ms');
        expect(output).toContain('broadcast_queue_depth');
    });

    it('includes JSON metrics for health endpoint', () => {
        const json = metrics.getMetricsJSON();
        expect(json).toHaveProperty('counters');
        expect(json).toHaveProperty('histograms');
        expect(json).toHaveProperty('gauges');
    });
});

// ============================================================================
// PHASE 1 (F-series): OBSERVABILITY BASELINE REGISTRATION
// Asserts presence of all counters/gauges/histograms introduced by A1-A9 in
// the Phase 1 observability baseline. Counter + histogram misses log a warn
// via logger.warn("... ${name} not found"); gauges silently no-op, so we
// verify their presence through getMetricsJSON() instead.
// ============================================================================

describe('Phase 1 (F-series): Observability Baseline Registration', () => {
    const counters = [
        'new_assignment_dispatch_total',
        'new_assignment_socket_emit_total',
        'new_assignment_outbox_insert_total',
        'new_assignment_fcm_enqueue_total',
        'fleetcache_read_total',
        'dlq_pushed_total',
        'hold_confirmed_committed_total',
        'driver_accepted_total',
        'driver_declined_total',
        'driver_timeout_total',
        'driver_reassign_issued_total',
        'driver_overlay_rendered_total',
        'fcm_quota_consumed_total',
    ];

    counters.forEach((name) => {
        it(`${name} counter is registered`, () => {
            const spy = jest.spyOn(console, 'warn').mockImplementation();
            metrics.incrementCounter(name, { label: 'test' }, 1);
            expect(spy).not.toHaveBeenCalledWith(
                expect.stringContaining(`Counter ${name} not found`)
            );
            spy.mockRestore();
        });
    });

    it('circuit_breaker_state_gauge gauge is registered', () => {
        metrics.setGauge('circuit_breaker_state_gauge', 1);
        const json = metrics.getMetricsJSON() as { gauges: Record<string, unknown> };
        expect(json.gauges).toHaveProperty('circuit_breaker_state_gauge');
    });

    it('stream_depth gauge is registered', () => {
        metrics.setGauge('stream_depth', 0);
        const json = metrics.getMetricsJSON() as { gauges: Record<string, unknown> };
        expect(json.gauges).toHaveProperty('stream_depth');
    });

    it('pool_wait_seconds histogram is registered', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.observeHistogram('pool_wait_seconds', 0.05, { pool_name: 'primary' });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('Histogram pool_wait_seconds not found')
        );
        spy.mockRestore();
    });
});
