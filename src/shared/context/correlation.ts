/**
 * =============================================================================
 * CORRELATION ID CONTEXT - AsyncLocalStorage-based Request Tracing
 * =============================================================================
 *
 * Fix G4 (F-7-25): Provides correlation IDs for background jobs and requests.
 * Uses AsyncLocalStorage for zero-overhead context propagation.
 *
 * Usage:
 *   - Express middleware: app.use(correlationMiddleware)
 *   - Background jobs: withCorrelation('bg:cleanup', () => { ... })
 *   - Read current ID: getCorrelationId()
 *
 * =============================================================================
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

interface CorrelationContext {
  correlationId: string;
}

const correlationStore = new AsyncLocalStorage<CorrelationContext>();

/**
 * Get the current correlation ID from AsyncLocalStorage context.
 * Returns a fallback ID if no context is active.
 */
export function getCorrelationId(): string {
  return correlationStore.getStore()?.correlationId ?? `no-ctx:${randomUUID().slice(0, 8)}`;
}

/**
 * Express middleware that sets a correlation ID for each request.
 * Reads X-Correlation-ID header if present, otherwise generates one.
 */
export function correlationMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    `req:${randomUUID().slice(0, 8)}`;
  correlationStore.run({ correlationId }, () => next());
}

/**
 * Run a function within a correlation context (for background jobs).
 *
 * @param prefix - Job type prefix (e.g., 'bg:cleanup', 'bg:expiry')
 * @param fn - The function to run within the correlation context
 * @returns The return value of fn
 */
export function withCorrelation<T>(prefix: string, fn: () => T): T {
  const correlationId = `${prefix}:${randomUUID().slice(0, 8)}`;
  return correlationStore.run({ correlationId }, fn);
}
