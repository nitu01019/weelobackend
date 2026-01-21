/**
 * =============================================================================
 * SECURITY MIDDLEWARE
 * =============================================================================
 *
 * Comprehensive security middleware for production-ready API.
 *
 * SECURITY FEATURES:
 * - Helmet security headers
 * - Input sanitization (XSS, SQL injection prevention)
 * - Request size limiting
 * - CORS configuration
 * - Request ID tracking
 *
 * SCALABILITY:
 * - Stateless design
 * - Low overhead
 * - Works with load balancers
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
/**
 * Generate and attach request ID for tracking
 */
export declare function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void;
/**
 * Security headers using Helmet
 * Configurable for different environments
 */
export declare const securityHeaders: (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: (err?: unknown) => void) => void;
/**
 * Input sanitization middleware
 * Prevents XSS and injection attacks
 */
export declare function sanitizeInput(req: Request, _res: Response, next: NextFunction): void;
/**
 * Prevent parameter pollution
 */
export declare function preventParamPollution(req: Request, _res: Response, next: NextFunction): void;
/**
 * Block suspicious requests
 */
export declare function blockSuspiciousRequests(req: Request, res: Response, next: NextFunction): void;
/**
 * Add security response headers
 */
export declare function securityResponseHeaders(_req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=security.middleware.d.ts.map