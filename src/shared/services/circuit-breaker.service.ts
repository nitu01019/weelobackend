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

// Default: ENABLED. Opt-out by setting FF_CIRCUIT_BREAKER_ENABLED=false.
// Rationale: Circuit breakers protect against cascading failures. Defaulting
// to disabled means new deployments are unprotected until manually enabled.
// Industry standard (Netflix, Uber): resilience features are ON by default.
const FF_CIRCUIT_BREAKER_ENABLED = process.env.FF_CIRCUIT_BREAKER_ENABLED !== 'false';

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

    // ==========================================================================
    // IN-MEMORY FALLBACK — When Redis Is Down
    // ==========================================================================
    // Without this: Redis down → recordFailure() silently fails → failures never
    // counted → circuit never opens → cascading failures to downstream services.
    //
    // With this: Each ECS instance tracks failures locally. Not shared across
    // instances, but still protects THIS instance from cascading failures.
    //
    // Industry standard (Uber): In-memory circuit breaker state with Redis
    // sharing. If Redis is down, each instance maintains its own local state.
    // ==========================================================================
    private localFailureTimestamps: number[] = [];
    private localOpenUntil: number = 0;

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
            // Redis down → check local in-memory state instead of blindly assuming CLOSED
            return this.getLocalState();
        }
    }

    /**
     * Get circuit state from in-memory fallback.
     * Used when Redis is unreachable.
     */
    private getLocalState(): CircuitState {
        if (Date.now() < this.localOpenUntil) {
            return CircuitState.OPEN;
        }
        return CircuitState.CLOSED;
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
        // Always record locally (zero-cost, in-memory) — serves as Redis fallback
        this.recordLocalFailure();

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
            // Redis down — local fallback already recorded above
            logger.warn(`[CircuitBreaker] Redis unavailable, using local fallback for ${this.name}`);
        }
    }

    /**
     * Record failure in local in-memory counter.
     * Prunes timestamps outside the sliding window.
     * Opens circuit locally if threshold exceeded.
     */
    private recordLocalFailure(): void {
        const now = Date.now();
        const windowStart = now - (this.windowSeconds * 1000);

        // Prune old entries outside the sliding window
        this.localFailureTimestamps = this.localFailureTimestamps.filter(ts => ts > windowStart);

        // Add current failure
        this.localFailureTimestamps.push(now);

        // Check threshold
        if (this.localFailureTimestamps.length >= this.threshold) {
            this.localOpenUntil = now + (this.openDurationSeconds * 1000);
            logger.error(`[CircuitBreaker] OPEN (local): ${this.name} (${this.localFailureTimestamps.length} failures in ${this.windowSeconds}s window)`);
            metrics.incrementCounter('circuit_breaker_open', { service: this.name, source: 'local' });
        }
    }

    /**
     * Record success. Close circuit — remove open flag, failure counter, probe lock.
     */
    private async recordSuccess(): Promise<void> {
        // Always reset local state
        this.localFailureTimestamps = [];
        this.localOpenUntil = 0;

        try {
            // Reset all Redis circuit state
            await Promise.all([
                redisService.del(this.failureKey),
                redisService.del(this.openKey),
                redisService.del(this.probeLockKey)
            ]);

            logger.info(`[CircuitBreaker] CLOSED: ${this.name} (probe success)`);
            metrics.incrementCounter('circuit_breaker_closed', { service: this.name });
        } catch {
            // Redis down — local state already reset above
            logger.warn(`[CircuitBreaker] Redis unavailable, local state reset for ${this.name}`);
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
