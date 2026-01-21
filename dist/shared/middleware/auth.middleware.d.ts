/**
 * =============================================================================
 * AUTH MIDDLEWARE
 * =============================================================================
 *
 * Authentication and authorization middleware.
 *
 * SECURITY:
 * - Token validation on every request
 * - Role-based access control
 * - No trust by default
 * =============================================================================
 */
import { Request, Response, NextFunction } from 'express';
/**
 * User roles enum
 */
export declare enum UserRole {
    CUSTOMER = "customer",
    TRANSPORTER = "transporter",
    DRIVER = "driver",
    ADMIN = "admin"
}
/**
 * Extended Request type with user info
 */
declare global {
    namespace Express {
        interface Request {
            user?: {
                userId: string;
                role: string;
                phone: string;
            };
            userId?: string;
            userRole?: string;
            userPhone?: string;
        }
    }
}
/**
 * Auth middleware - validates JWT token
 * Must be applied to all protected routes
 */
export declare function authMiddleware(req: Request, _res: Response, next: NextFunction): void;
/**
 * Role guard - restricts access to specific roles
 * Must be used after authMiddleware
 *
 * @param allowedRoles - Array of roles that can access the route
 */
export declare function roleGuard(allowedRoles: string[]): (req: Request, _res: Response, next: NextFunction) => void;
/**
 * Authorize middleware - checks if user has required role
 * Alias for roleGuard for compatibility with existing code
 */
export declare function authorize(...allowedRoles: (string | UserRole)[]): (req: Request, _res: Response, next: NextFunction) => void;
/**
 * Authenticate middleware - alias for authMiddleware
 * For compatibility with existing code
 */
export declare const authenticate: typeof authMiddleware;
/**
 * Optional auth middleware - validates token if present but doesn't require it
 * Useful for endpoints that work differently for authenticated vs anonymous users
 */
export declare function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): void;
/**
 * Optional auth - alias for optionalAuthMiddleware
 */
export declare const optionalAuth: typeof optionalAuthMiddleware;
//# sourceMappingURL=auth.middleware.d.ts.map