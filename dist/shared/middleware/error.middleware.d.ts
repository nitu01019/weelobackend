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
import { AppError } from '../types/error.types';
/**
 * Global error handler middleware
 * Must be the last middleware in the chain
 */
export declare function errorHandler(error: Error | AppError, req: Request, res: Response, _next: NextFunction): void;
/**
 * Async route wrapper to catch async errors
 * Use this to wrap async route handlers
 */
export declare function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Not found error handler
 */
export declare function notFoundHandler(req: Request, res: Response): void;
//# sourceMappingURL=error.middleware.d.ts.map