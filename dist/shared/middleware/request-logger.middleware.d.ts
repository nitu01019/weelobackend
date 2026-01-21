/**
 * =============================================================================
 * REQUEST LOGGER MIDDLEWARE
 * =============================================================================
 *
 * Logs all incoming requests for debugging and audit purposes.
 *
 * SECURITY:
 * - Does not log request bodies (may contain sensitive data)
 * - Does not log authorization headers
 * - Masks sensitive query parameters
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
/**
 * Request logger middleware
 */
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=request-logger.middleware.d.ts.map