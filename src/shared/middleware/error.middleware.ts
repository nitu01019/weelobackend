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
  // Log the full error server-side
  logger.error('Request error', {
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: (req as any).userId || 'anonymous'
  });

  // Determine if this is a known operational error
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && { details: error.details })
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
      message: config.isProduction 
        ? 'An unexpected error occurred. Please try again later.'
        : error.message // Show details only in development
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
