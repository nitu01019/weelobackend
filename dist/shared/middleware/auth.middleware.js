"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalAuth = exports.authenticate = exports.UserRole = void 0;
exports.authMiddleware = authMiddleware;
exports.roleGuard = roleGuard;
exports.authorize = authorize;
exports.optionalAuthMiddleware = optionalAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const environment_1 = require("../../config/environment");
const error_types_1 = require("../types/error.types");
const logger_service_1 = require("../services/logger.service");
/**
 * User roles enum
 */
var UserRole;
(function (UserRole) {
    UserRole["CUSTOMER"] = "customer";
    UserRole["TRANSPORTER"] = "transporter";
    UserRole["DRIVER"] = "driver";
    UserRole["ADMIN"] = "admin";
})(UserRole || (exports.UserRole = UserRole = {}));
/**
 * Auth middleware - validates JWT token
 * Must be applied to all protected routes
 */
function authMiddleware(req, _res, next) {
    try {
        // Get token from header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new error_types_1.AppError(401, 'UNAUTHORIZED', 'Authentication required');
        }
        const token = authHeader.substring(7); // Remove 'Bearer '
        // Verify token
        const decoded = jsonwebtoken_1.default.verify(token, environment_1.config.jwt.secret);
        // Attach user to request (both formats for compatibility)
        req.user = {
            userId: decoded.userId,
            role: decoded.role,
            phone: decoded.phone
        };
        // Legacy format for existing controllers
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        req.userPhone = decoded.phone;
        next();
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            next(new error_types_1.AppError(401, 'TOKEN_EXPIRED', 'Token has expired'));
        }
        else if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            next(new error_types_1.AppError(401, 'INVALID_TOKEN', 'Invalid token'));
        }
        else if (error instanceof error_types_1.AppError) {
            next(error);
        }
        else {
            logger_service_1.logger.error('Auth middleware error', error);
            next(new error_types_1.AppError(401, 'UNAUTHORIZED', 'Authentication failed'));
        }
    }
}
/**
 * Role guard - restricts access to specific roles
 * Must be used after authMiddleware
 *
 * @param allowedRoles - Array of roles that can access the route
 */
function roleGuard(allowedRoles) {
    return (req, _res, next) => {
        if (!req.user) {
            next(new error_types_1.AppError(401, 'UNAUTHORIZED', 'Authentication required'));
            return;
        }
        if (!allowedRoles.includes(req.user.role)) {
            logger_service_1.logger.warn('Access denied - insufficient role', {
                userId: req.user.userId,
                role: req.user.role,
                requiredRoles: allowedRoles,
                path: req.path
            });
            next(new error_types_1.AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
            return;
        }
        next();
    };
}
/**
 * Authorize middleware - checks if user has required role
 * Alias for roleGuard for compatibility with existing code
 */
function authorize(...allowedRoles) {
    return roleGuard(allowedRoles.map(r => r.toString()));
}
/**
 * Authenticate middleware - alias for authMiddleware
 * For compatibility with existing code
 */
exports.authenticate = authMiddleware;
/**
 * Optional auth middleware - validates token if present but doesn't require it
 * Useful for endpoints that work differently for authenticated vs anonymous users
 */
function optionalAuthMiddleware(req, _res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // No token - continue without user
            next();
            return;
        }
        const token = authHeader.substring(7);
        const decoded = jsonwebtoken_1.default.verify(token, environment_1.config.jwt.secret);
        req.user = {
            userId: decoded.userId,
            role: decoded.role,
            phone: decoded.phone
        };
        // Legacy format for existing controllers
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        req.userPhone = decoded.phone;
        next();
    }
    catch (error) {
        // Invalid token - continue without user (don't fail)
        next();
    }
}
/**
 * Optional auth - alias for optionalAuthMiddleware
 */
exports.optionalAuth = optionalAuthMiddleware;
//# sourceMappingURL=auth.middleware.js.map