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
import { randomUUID } from 'crypto';
import { logger } from '../services/logger.service';
import { AppError } from '../types/error.types';
import { config } from '../../config/environment';

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
  // F-A-19: per-error UUID fingerprint so SREs can grep the same id across
  // CloudWatch logs and customer-facing error reports in O(1).
  const errorId = randomUUID();

  // Log the full error server-side
  logger.error('Request error', {
    errorId,
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: req.userId || 'anonymous',
    requestId
  });

  // Determine if this is a known operational error
  if (error instanceof AppError) {
    // Fix G3: Sanitize error details outside development to prevent leaking internal state
    // M8: Allow details for 4xx errors (field-level validation, rate-limit info) — only strip for 5xx
    const safeDetails = error.details && (config.isDevelopment || error.statusCode < 500)
      ? error.details
      : undefined;
    // M7: RFC 6585 — 429 responses SHOULD include Retry-After header
    if (error.statusCode === 429) {
      const retryAfter = error.details?.retryAfter ?? error.details?.retryAfterSeconds ?? '30';
      res.setHeader('Retry-After', String(retryAfter));
    }
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(safeDetails && { details: safeDetails }),
        ...(requestId && { requestId }),
        errorId
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
      ...(requestId && { requestId }),
      errorId
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
