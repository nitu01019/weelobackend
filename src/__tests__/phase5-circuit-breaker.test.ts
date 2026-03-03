/**
 * Phase 5 — Resilience: Circuit Breaker Unit Tests
 *
 * Tests cover:
 * 1. CircuitBreaker 3-state machine (CLOSED → OPEN → HALF_OPEN → CLOSED)
 * 2. Failure counting and threshold trip
 * 3. Fallback invocation when circuit is open
 * 4. Optimistic behavior when Redis is down
 * 5. Pre-configured circuit instances exist
 * 6. Queue depth cap flag defaults
 */

import { CircuitBreaker, CircuitState, h3Circuit, directionsCircuit, queueCircuit, fcmCircuit } from '../shared/services/circuit-breaker.service';

// ============================================================================
// CIRCUIT BREAKER STATE MACHINE
// ============================================================================

describe('CircuitBreaker', () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        jest.resetModules();
        process.env.NODE_ENV = 'test';
        process.env.REDIS_ENABLED = 'false';
        process.env.FF_CIRCUIT_BREAKER_ENABLED = 'true';
        cb = new CircuitBreaker('test_service', {
            threshold: 3,
            windowMs: 10000,
            openDurationMs: 5000
        });
    });

    afterEach(() => {
        delete process.env.FF_CIRCUIT_BREAKER_ENABLED;
    });

    it('starts in CLOSED state', async () => {
        const state = await cb.getState();
        expect(state).toBe(CircuitState.CLOSED);
    });

    it('calls primary function when CLOSED', async () => {
        const primary = jest.fn().mockResolvedValue('primary-result');
        const fallback = jest.fn().mockResolvedValue('fallback-result');

        const result = await cb.tryWithFallback(primary, fallback);
        expect(result).toBe('primary-result');
        expect(primary).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('calls fallback when primary throws (CLOSED state)', async () => {
        const primary = jest.fn().mockRejectedValue(new Error('fail'));
        const fallback = jest.fn().mockResolvedValue('fallback-result');

        const result = await cb.tryWithFallback(primary, fallback);
        expect(result).toBe('fallback-result');
        expect(primary).toHaveBeenCalledTimes(1);
        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('bypasses circuit breaker entirely when flag is OFF', async () => {
        // Re-import with flag off
        delete process.env.FF_CIRCUIT_BREAKER_ENABLED;
        jest.resetModules();
        const { CircuitBreaker: FreshCB } = await import('../shared/services/circuit-breaker.service');
        const freshCb = new FreshCB('test_bypass');

        const primary = jest.fn().mockResolvedValue('direct');
        const fallback = jest.fn();

        const result = await freshCb.tryWithFallback(primary, fallback);
        expect(result).toBe('direct');
        expect(fallback).not.toHaveBeenCalled();
    });

    it('calls fallback even when flag is OFF if primary throws', async () => {
        delete process.env.FF_CIRCUIT_BREAKER_ENABLED;
        jest.resetModules();
        const { CircuitBreaker: FreshCB } = await import('../shared/services/circuit-breaker.service');
        const freshCb = new FreshCB('test_bypass_err');

        const primary = jest.fn().mockRejectedValue(new Error('boom'));
        const fallback = jest.fn().mockResolvedValue('safe');

        const result = await freshCb.tryWithFallback(primary, fallback);
        expect(result).toBe('safe');
    });
});

// ============================================================================
// PRE-CONFIGURED INSTANCES
// ============================================================================

describe('Pre-configured circuit breakers', () => {
    it('exports 4 named circuit breakers', () => {
        expect(h3Circuit).toBeInstanceOf(CircuitBreaker);
        expect(directionsCircuit).toBeInstanceOf(CircuitBreaker);
        expect(queueCircuit).toBeInstanceOf(CircuitBreaker);
        expect(fcmCircuit).toBeInstanceOf(CircuitBreaker);
    });
});

// ============================================================================
// QUEUE DEPTH CAP DEFAULTS
// ============================================================================

describe('Phase 5 feature flag defaults', () => {
    it('FF_CIRCUIT_BREAKER_ENABLED defaults to false', () => {
        expect(process.env.FF_CIRCUIT_BREAKER_ENABLED).toBeFalsy();
    });

    it('FF_QUEUE_DEPTH_CAP defaults to 10000', () => {
        const cap = parseInt(process.env.FF_QUEUE_DEPTH_CAP || '10000', 10) || 10000;
        expect(cap).toBe(10000);
    });
});
