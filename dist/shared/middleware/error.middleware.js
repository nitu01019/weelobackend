"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
exports.asyncHandler = asyncHandler;
exports.notFoundHandler = notFoundHandler;
const logger_service_1 = require("../services/logger.service");
const error_types_1 = require("../types/error.types");
const environment_1 = require("../../config/environment");
/**
 * Global error handler middleware
 * Must be the last middleware in the chain
 */
function errorHandler(error, req, res, _next) {
    // Log the full error server-side
    logger_service_1.logger.error('Request error', {
        error: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method,
        ip: req.ip,
        userId: req.userId || 'anonymous'
    });
    // Determine if this is a known operational error
    if (error instanceof error_types_1.AppError) {
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
            message: environment_1.config.isProduction
                ? 'An unexpected error occurred. Please try again later.'
                : error.message // Show details only in development
        }
    });
}
/**
 * Async route wrapper to catch async errors
 * Use this to wrap async route handlers
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
/**
 * Not found error handler
 */
function notFoundHandler(req, res) {
    res.status(404).json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: `Cannot ${req.method} ${req.path}`
        }
    });
}
//# sourceMappingURL=error.middleware.js.map