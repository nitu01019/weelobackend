/**
 * =============================================================================
 * CIRCUIT BREAKER SERVICE — Phase 5 Resilience
 * =============================================================================
 *
 * Redis-backed circuit breaker (Hystrix-inspired, no external library).
 *
 * 3 STATES:
 *   CLOSED  → Normal operation. Failures counted in sliding window.
 *   OPEN    → All calls go to fallback. Auto-transitions to HALF_OPEN after cooldown.
 *   HALF_OPEN → One probe call allowed. Success → CLOSED. Failure → OPEN again.
 *
 * ZERO LATENCY IMPACT:
 *   - State check = 1 Redis GET (sub-ms on ElastiCache)
 *   - Failure recording = 1 Redis INCR + EXPIRE (async, non-blocking)
 *   - If Redis itself is down → assume CLOSED (optimistic, try primary)
 *
 * FEATURE-FLAGGED:
 *   FF_CIRCUIT_BREAKER_ENABLED=false (default) → all calls go directly to primary
 *
 * =============================================================================
 */

import { redisService } from './redis.service';
import { logger } from './logger.service';
import { metrics } from '../monitoring/metrics.service';

// =============================================================================
// CONFIGURATION
// =============================================================================

const FF_CIRCUIT_BREAKER_ENABLED = process.env.FF_CIRCUIT_BREAKER_ENABLED === 'true';

const DEFAULT_THRESHOLD = Math.max(
    1,
    parseInt(process.env.FF_CIRCUIT_BREAKER_THRESHOLD || '5', 10) || 5
);

const DEFAULT_WINDOW_MS = Math.max(
    1000,
    parseInt(process.env.FF_CIRCUIT_BREAKER_WINDOW_MS || '30000', 10) || 30000
);

const DEFAULT_OPEN_DURATION_MS = Math.max(
    5000,
    parseInt(process.env.FF_CIRCUIT_BREAKER_OPEN_DURATION_MS || '60000', 10) || 60000
);

// =============================================================================
// TYPES
// =============================================================================

export enum CircuitState {
    CLOSED = 'CLOSED',
    OPEN = 'OPEN',
    HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerOptions {
    /** Number of failures before circuit opens */
    threshold?: number;
    /** Sliding window for failure counting (ms) */
    windowMs?: number;
    /** How long circuit stays open before probing (ms) */
    openDurationMs?: number;
}

// =============================================================================
// CIRCUIT BREAKER CLASS
// =============================================================================

export class CircuitBreaker {
    private readonly name: string;
    private readonly threshold: number;
    private readonly windowSeconds: number;
    private readonly openDurationSeconds: number;

    // Redis keys
    private readonly failureKey: string;
    private readonly openKey: string;
    private readonly probeLockKey: string;

    constructor(name: string, options: CircuitBreakerOptions = {}) {
        this.name = name;
        this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
        this.windowSeconds = Math.ceil((options.windowMs ?? DEFAULT_WINDOW_MS) / 1000);
        this.openDurationSeconds = Math.ceil((options.openDurationMs ?? DEFAULT_OPEN_DURATION_MS) / 1000);

        this.failureKey = `circuit:${name}:failures`;
        this.openKey = `circuit:${name}:open`;
        this.probeLockKey = `circuit:${name}:probe_lock`;
    }

    /**
     * Execute primary function with automatic fallback on failure or open circuit.
     *
     * ZERO OVERHEAD when FF_CIRCUIT_BREAKER_ENABLED=false:
     *   → Calls primary directly, no Redis check.
     *
     * When enabled:
     *   CLOSED    → Run primary. On error: record failure, run fallback.
     *   OPEN      → Skip primary, run fallback immediately.
     *   HALF_OPEN → One probe call (atomic lock), rest go to fallback.
     */
    async tryWithFallback<T>(
        primary: () => Promise<T>,
        fallback: () => Promise<T>
    ): Promise<T> {
        // Flag OFF → bypass entirely (zero Redis calls)
        if (!FF_CIRCUIT_BREAKER_ENABLED) {
            try {
                return await primary();
            } catch {
                return fallback();
            }
        }

        const state = await this.getState();

        if (state === CircuitState.OPEN) {
            // Try to acquire probe lock (HALF_OPEN transition)
            // Only 1 request gets the lock — rest go to fallback (no stampede)
            const acquiredProbe = await this.tryAcquireProbeLock();
            if (acquiredProbe) {
                // This request is the probe
                try {
                    const result = await primary();
                    await this.recordSuccess();
                    metrics.incrementCounter('circuit_breaker_probe_success', { service: this.name });
                    return result;
                } catch (error: any) {
                    await this.recordFailure();
                    metrics.incrementCounter('circuit_breaker_probe_failure', { service: this.name });
                    return fallback();
                }
            }
            // Not the probe — go to fallback
            metrics.incrementCounter('circuit_breaker_fallback', { service: this.name, reason: 'open' });
            return fallback();
        }

        // CLOSED — normal path
        try {
            const result = await primary();
            return result;
        } catch (error: any) {
            await this.recordFailure();
            metrics.incrementCounter('circuit_breaker_fallback', { service: this.name, reason: 'error' });
            return fallback();
        }
    }

    /**
     * Get current circuit state.
     * Single Redis GET — returns CLOSED or OPEN.
     * If Redis is down → assume CLOSED (optimistic).
     */
    async getState(): Promise<CircuitState> {
        try {
            const isOpen = await redisService.get(this.openKey);
            return isOpen === '1' ? CircuitState.OPEN : CircuitState.CLOSED;
        } catch {
            // Redis down → assume CLOSED (optimistic — try primary)
            return CircuitState.CLOSED;
        }
    }

    /**
     * Atomically try to acquire the probe lock.
     * Returns true if this caller is the probe owner, false otherwise.
     * Lock auto-expires after 10s to prevent deadlocks.
     */
    private async tryAcquireProbeLock(): Promise<boolean> {
        try {
            // SETNX: only succeeds if key does not exist → atomic probe lock
            const result = await redisService.incr(this.probeLockKey);
            if (result === 1) {
                // We got the lock — set TTL to prevent deadlock if probe crashes
                await redisService.expire(this.probeLockKey, 10);
                return true;
            }
            return false; // Another request already probing
        } catch {
            return false; // Redis down → don't probe, use fallback
        }
    }

    /**
     * Record a failure. If threshold exceeded → open circuit.
     */
    private async recordFailure(): Promise<void> {
        try {
            const count = await redisService.incr(this.failureKey);
            await redisService.expire(this.failureKey, this.windowSeconds);

            if (count >= this.threshold) {
                // Open circuit with TTL — auto-closes after openDurationSeconds
                await redisService.set(this.openKey, '1', this.openDurationSeconds);

                logger.error(`[CircuitBreaker] OPEN: ${this.name} (${count} failures in ${this.windowSeconds}s window)`);
                metrics.incrementCounter('circuit_breaker_open', { service: this.name });
            }
        } catch {
            // Recording failure failed — don't crash the caller
            logger.warn(`[CircuitBreaker] Failed to record failure for ${this.name}`);
        }
    }

    /**
     * Record success. Close circuit — remove open flag, failure counter, probe lock.
     */
    private async recordSuccess(): Promise<void> {
        try {
            // Reset all circuit state
            await Promise.all([
                redisService.del(this.failureKey),
                redisService.del(this.openKey),
                redisService.del(this.probeLockKey)
            ]);

            logger.info(`[CircuitBreaker] CLOSED: ${this.name} (probe success)`);
            metrics.incrementCounter('circuit_breaker_closed', { service: this.name });
        } catch {
            // Best-effort
            logger.warn(`[CircuitBreaker] Failed to record success for ${this.name}`);
        }
    }
}

// =============================================================================
// PRE-CONFIGURED CIRCUIT BREAKERS
// =============================================================================

/** H3 geo-index lookup → fallback to GEORADIUS */
export const h3Circuit = new CircuitBreaker('h3_index');

/** Google Directions API → fallback to haversine */
export const directionsCircuit = new CircuitBreaker('directions_api');

/** Queue service (Redis-backed) → fallback to synchronous emit */
export const queueCircuit = new CircuitBreaker('queue_service');

/** FCM delivery → fallback to socket-only */
export const fcmCircuit = new CircuitBreaker('fcm_delivery');
