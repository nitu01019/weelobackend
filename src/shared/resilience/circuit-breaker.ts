/**
 * =============================================================================
 * CIRCUIT BREAKER - Graceful Failure Handling
 * =============================================================================
 * 
 * Prevents cascading failures when external services are down.
 * 
 * STATES:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service has recovered
 * 
 * WHY THIS MATTERS FOR MILLIONS OF USERS:
 * - When SMS provider is down, don't hammer it with retries
 * - When database is slow, prevent request pile-up
 * - Fast failure = better user experience than hanging requests
 * - Protects system resources during partial outages
 * 
 * USAGE:
 * ```typescript
 * const smsBreaker = new CircuitBreaker('sms-service', {
 *   failureThreshold: 5,    // Open after 5 failures
 *   resetTimeout: 30000,    // Try again after 30 seconds
 *   monitorTimeout: 10000   // Time window for failure counting
 * });
 * 
 * const result = await smsBreaker.execute(() => sendSMS(phone, message));
 * ```
 * =============================================================================
 */

import { logger } from '../services/logger.service';
import { metrics } from '../monitoring/metrics.service';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN' // Testing recovery
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerOptions {
  /** Name for logging/metrics */
  name: string;
  /** Number of failures before opening circuit */
  failureThreshold?: number;
  /** Number of successes in half-open to close circuit */
  successThreshold?: number;
  /** Time to wait before trying again (ms) */
  resetTimeout?: number;
  /** Time window for counting failures (ms) */
  monitorTimeout?: number;
  /** Timeout for individual requests (ms) */
  requestTimeout?: number;
  /** Function to determine if error should count as failure */
  isFailure?: (error: Error) => boolean;
  /** Callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Default configuration
 */
const DEFAULT_OPTIONS: Required<Omit<CircuitBreakerOptions, 'name' | 'onStateChange' | 'isFailure'>> = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeout: 30000,
  monitorTimeout: 10000,
  requestTimeout: 10000
};

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  constructor(public circuitName: string) {
    super(`Circuit breaker '${circuitName}' is OPEN - service unavailable`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Error thrown when request times out
 */
export class CircuitTimeoutError extends Error {
  constructor(public circuitName: string, public timeout: number) {
    super(`Circuit breaker '${circuitName}' request timed out after ${timeout}ms`);
    this.name = 'CircuitTimeoutError';
  }
}

/**
 * Circuit Breaker Implementation
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number = 0;
  private nextAttemptTime: number = 0;
  private options: Required<Omit<CircuitBreakerOptions, 'onStateChange' | 'isFailure'>> & 
    Pick<CircuitBreakerOptions, 'onStateChange' | 'isFailure'>;
  
  constructor(options: CircuitBreakerOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
    
    logger.info(`Circuit breaker '${this.options.name}' initialized`, {
      failureThreshold: this.options.failureThreshold,
      resetTimeout: this.options.resetTimeout
    });
  }
  
  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      if (Date.now() >= this.nextAttemptTime) {
        this.transitionTo(CircuitState.HALF_OPEN);
      } else {
        this.recordRejection();
        throw new CircuitOpenError(this.options.name);
      }
    }
    
    // Execute with timeout
    try {
      const result = await this.executeWithTimeout(fn);
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error as Error);
      throw error;
    }
  }
  
  /**
   * Execute with timeout protection
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new CircuitTimeoutError(this.options.name, this.options.requestTimeout));
      }, this.options.requestTimeout);
      
      fn()
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
  
  /**
   * Record a successful execution
   */
  private recordSuccess(): void {
    this.failures = 0;
    this.successes++;
    
    metrics.incrementCounter('circuit_breaker_success', { circuit: this.options.name });
    
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successes >= this.options.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
  }
  
  /**
   * Record a failed execution
   */
  private recordFailure(error: Error): void {
    // Check if this error should count as failure
    if (this.options.isFailure && !this.options.isFailure(error)) {
      return;
    }
    
    this.successes = 0;
    this.failures++;
    this.lastFailureTime = Date.now();
    
    metrics.incrementCounter('circuit_breaker_failure', { circuit: this.options.name });
    
    logger.warn(`Circuit '${this.options.name}' failure ${this.failures}/${this.options.failureThreshold}`, {
      error: error.message
    });
    
    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open immediately opens the circuit
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      // Check if we should open based on failure count within time window
      if (this.failures >= this.options.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }
  
  /**
   * Record a rejected request (circuit was open)
   */
  private recordRejection(): void {
    metrics.incrementCounter('circuit_breaker_rejected', { circuit: this.options.name });
  }
  
  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    
    logger.info(`Circuit '${this.options.name}' state change: ${oldState} -> ${newState}`);
    metrics.incrementCounter('circuit_breaker_state_change', { 
      circuit: this.options.name,
      from: oldState,
      to: newState
    });
    
    if (newState === CircuitState.OPEN) {
      this.nextAttemptTime = Date.now() + this.options.resetTimeout;
      logger.warn(`Circuit '${this.options.name}' OPEN - will retry at ${new Date(this.nextAttemptTime).toISOString()}`);
    } else if (newState === CircuitState.CLOSED) {
      this.failures = 0;
      this.successes = 0;
      logger.info(`Circuit '${this.options.name}' recovered and CLOSED`);
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successes = 0;
      logger.info(`Circuit '${this.options.name}' testing recovery (HALF_OPEN)`);
    }
    
    // Notify callback
    if (this.options.onStateChange) {
      this.options.onStateChange(oldState, newState);
    }
  }
  
  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }
  
  /**
   * Get circuit statistics
   */
  getStats(): {
    name: string;
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime: number | null;
    nextAttemptTime: number | null;
  } {
    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime || null,
      nextAttemptTime: this.state === CircuitState.OPEN ? this.nextAttemptTime : null
    };
  }
  
  /**
   * Manually reset the circuit to closed state
   */
  reset(): void {
    this.transitionTo(CircuitState.CLOSED);
    logger.info(`Circuit '${this.options.name}' manually reset`);
  }
  
  /**
   * Manually open the circuit (for maintenance)
   */
  trip(): void {
    this.transitionTo(CircuitState.OPEN);
    logger.info(`Circuit '${this.options.name}' manually tripped`);
  }
}

// =============================================================================
// PRE-CONFIGURED CIRCUIT BREAKERS
// =============================================================================

/**
 * Circuit breaker for SMS service
 */
export const smsCircuitBreaker = new CircuitBreaker({
  name: 'sms-service',
  failureThreshold: 3,
  resetTimeout: 60000,  // 1 minute
  requestTimeout: 10000, // 10 seconds
  isFailure: (error) => {
    // Don't count validation errors as service failures
    return !error.message.includes('Invalid phone');
  }
});

/**
 * Circuit breaker for external APIs (maps, geocoding, etc.)
 */
export const externalApiCircuitBreaker = new CircuitBreaker({
  name: 'external-api',
  failureThreshold: 5,
  resetTimeout: 30000,
  requestTimeout: 15000
});

/**
 * Circuit breaker for database operations (when using external DB)
 */
export const databaseCircuitBreaker = new CircuitBreaker({
  name: 'database',
  failureThreshold: 3,
  resetTimeout: 10000,
  requestTimeout: 5000
});

/**
 * Circuit breaker for push notifications (FCM)
 */
export const fcmCircuitBreaker = new CircuitBreaker({
  name: 'fcm-service',
  failureThreshold: 5,
  resetTimeout: 30000,
  requestTimeout: 10000
});

// =============================================================================
// CIRCUIT BREAKER REGISTRY
// =============================================================================

/**
 * Registry for managing all circuit breakers
 */
class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker> = new Map();
  
  /**
   * Register a circuit breaker
   */
  register(breaker: CircuitBreaker): void {
    const stats = breaker.getStats();
    this.breakers.set(stats.name, breaker);
  }
  
  /**
   * Get a circuit breaker by name
   */
  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }
  
  /**
   * Get all circuit breaker stats
   */
  getAllStats(): Array<ReturnType<CircuitBreaker['getStats']>> {
    return Array.from(this.breakers.values()).map(b => b.getStats());
  }
  
  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

// Register default breakers
circuitBreakerRegistry.register(smsCircuitBreaker);
circuitBreakerRegistry.register(externalApiCircuitBreaker);
circuitBreakerRegistry.register(databaseCircuitBreaker);
circuitBreakerRegistry.register(fcmCircuitBreaker);
