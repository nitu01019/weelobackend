/**
 * =============================================================================
 * ERROR HANDLING MIDDLEWARE
 * =============================================================================
 * 
 * Centralized error handling for all routes.
 * 
 * SECURITY:
 * - Stack traces never reach clients
 * - Internal error messages are hidden
 * - All errors are logged server-side
 * - User receives safe, generic error responses
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';
import { AppError, BackpressureError } from '../types/error.types';
import { config } from '../../config/environment';

const RETRY_AFTER_STATUSES = new Set<number>([429, 503]);

function setRetryAfterIfApplicable(res: Response, error: AppError): void {
  if (!RETRY_AFTER_STATUSES.has(error.statusCode)) return;
  // RFC 7231 §7.1.3 `delta-seconds = 1*DIGIT`: coerce to non-negative integer.
  // CloudFlare/ALB strip non-integer Retry-After; producers passing float (e.g. ttl=5.7)
  // would silently lose the header without this guard.
  const raRaw = error.details?.retryAfter ?? error.details?.retryAfterSeconds ?? 30;
  const ra = Math.max(0, Math.floor(Number(raRaw) || 30));
  res.setHeader('Retry-After', String(ra));
}

/**
 * Global error handler middleware
 * Must be the last middleware in the chain
 */
export function errorHandler(
  error: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req.headers['x-request-id'] as string) || undefined;

  // Server-side log — include BackpressureError internal context if present (CWE-209: never serialized).
  const isBackpressure = error instanceof BackpressureError;
  logger.error('Request error', {
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: req.userId || 'anonymous',
    requestId,
    ...(isBackpressure && {
      internalReason: (error as BackpressureError).internalReason,
      internalMeta: (error as BackpressureError).internalMeta,
    }),
  });

  // Determine if this is a known operational error
  if (error instanceof AppError) {
    setRetryAfterIfApplicable(res, error);
    // Fix G3: Sanitize error details outside development to prevent leaking internal state
    // M8: Allow details for 4xx errors (field-level validation, rate-limit info) — only strip for 5xx
    const safeDetails = error.details && (config.isDevelopment || error.statusCode < 500)
      ? error.details
      : undefined;
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(safeDetails && { details: safeDetails }),
        ...(requestId && { requestId })
      }
    });
    return;
  }

  // Unknown error - send generic response
  // SECURITY: Never expose internal error details to client
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isDevelopment
        ? error.message // Show details only in development
        : 'An unexpected error occurred. Please try again later.',
      ...(requestId && { requestId })
    }
  });
}

/**
 * Async route wrapper to catch async errors
 * Use this to wrap async route handlers
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Not found error handler
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`
    }
  });
}
