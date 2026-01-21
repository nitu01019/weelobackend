"use strict";
/**
 * =============================================================================
 * ERROR TYPES
 * =============================================================================
 *
 * Custom error classes for consistent error handling.
 * All operational errors should use AppError.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCode = exports.RateLimitError = exports.ConflictError = exports.NotFoundError = exports.AuthorizationError = exports.AuthenticationError = exports.ValidationError = exports.AppError = void 0;
/**
 * Application Error class
 * Use this for all known/expected errors
 */
class AppError extends Error {
    statusCode;
    code;
    details;
    isOperational = true;
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        // Maintains proper stack trace
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
/**
 * Validation Error - 400
 */
class ValidationError extends AppError {
    constructor(message, details) {
        super(400, 'VALIDATION_ERROR', message, details);
    }
}
exports.ValidationError = ValidationError;
/**
 * Authentication Error - 401
 */
class AuthenticationError extends AppError {
    constructor(message = 'Authentication required') {
        super(401, 'UNAUTHORIZED', message);
    }
}
exports.AuthenticationError = AuthenticationError;
/**
 * Authorization Error - 403
 */
class AuthorizationError extends AppError {
    constructor(message = 'Permission denied') {
        super(403, 'FORBIDDEN', message);
    }
}
exports.AuthorizationError = AuthorizationError;
/**
 * Not Found Error - 404
 */
class NotFoundError extends AppError {
    constructor(resource) {
        super(404, 'NOT_FOUND', `${resource} not found`);
    }
}
exports.NotFoundError = NotFoundError;
/**
 * Conflict Error - 409
 */
class ConflictError extends AppError {
    constructor(message) {
        super(409, 'CONFLICT', message);
    }
}
exports.ConflictError = ConflictError;
/**
 * Rate Limit Error - 429
 */
class RateLimitError extends AppError {
    constructor(message = 'Too many requests') {
        super(429, 'RATE_LIMIT_EXCEEDED', message);
    }
}
exports.RateLimitError = RateLimitError;
/**
 * Error codes enum for consistent error identification
 */
var ErrorCode;
(function (ErrorCode) {
    // Auth errors
    ErrorCode["INVALID_PHONE"] = "INVALID_PHONE";
    ErrorCode["INVALID_OTP"] = "INVALID_OTP";
    ErrorCode["OTP_EXPIRED"] = "OTP_EXPIRED";
    ErrorCode["TOKEN_EXPIRED"] = "TOKEN_EXPIRED";
    ErrorCode["INVALID_TOKEN"] = "INVALID_TOKEN";
    // Booking errors
    ErrorCode["BOOKING_NOT_FOUND"] = "BOOKING_NOT_FOUND";
    ErrorCode["BOOKING_ALREADY_FILLED"] = "BOOKING_ALREADY_FILLED";
    ErrorCode["BOOKING_CANCELLED"] = "BOOKING_CANCELLED";
    ErrorCode["BOOKING_EXPIRED"] = "BOOKING_EXPIRED";
    // Assignment errors
    ErrorCode["ASSIGNMENT_NOT_FOUND"] = "ASSIGNMENT_NOT_FOUND";
    ErrorCode["DRIVER_ALREADY_ASSIGNED"] = "DRIVER_ALREADY_ASSIGNED";
    ErrorCode["VEHICLE_ALREADY_ASSIGNED"] = "VEHICLE_ALREADY_ASSIGNED";
    // Tracking errors
    ErrorCode["TRACKING_NOT_FOUND"] = "TRACKING_NOT_FOUND";
    ErrorCode["INVALID_LOCATION"] = "INVALID_LOCATION";
    // General errors
    ErrorCode["VALIDATION_ERROR"] = "VALIDATION_ERROR";
    ErrorCode["INTERNAL_ERROR"] = "INTERNAL_ERROR";
    ErrorCode["NOT_FOUND"] = "NOT_FOUND";
    ErrorCode["RATE_LIMIT_EXCEEDED"] = "RATE_LIMIT_EXCEEDED";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
//# sourceMappingURL=error.types.js.map