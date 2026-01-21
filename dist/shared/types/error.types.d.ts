/**
 * =============================================================================
 * ERROR TYPES
 * =============================================================================
 *
 * Custom error classes for consistent error handling.
 * All operational errors should use AppError.
 * =============================================================================
 */
/**
 * Application Error class
 * Use this for all known/expected errors
 */
export declare class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly isOperational: boolean;
    constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>);
}
/**
 * Validation Error - 400
 */
export declare class ValidationError extends AppError {
    constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Authentication Error - 401
 */
export declare class AuthenticationError extends AppError {
    constructor(message?: string);
}
/**
 * Authorization Error - 403
 */
export declare class AuthorizationError extends AppError {
    constructor(message?: string);
}
/**
 * Not Found Error - 404
 */
export declare class NotFoundError extends AppError {
    constructor(resource: string);
}
/**
 * Conflict Error - 409
 */
export declare class ConflictError extends AppError {
    constructor(message: string);
}
/**
 * Rate Limit Error - 429
 */
export declare class RateLimitError extends AppError {
    constructor(message?: string);
}
/**
 * Error codes enum for consistent error identification
 */
export declare enum ErrorCode {
    INVALID_PHONE = "INVALID_PHONE",
    INVALID_OTP = "INVALID_OTP",
    OTP_EXPIRED = "OTP_EXPIRED",
    TOKEN_EXPIRED = "TOKEN_EXPIRED",
    INVALID_TOKEN = "INVALID_TOKEN",
    BOOKING_NOT_FOUND = "BOOKING_NOT_FOUND",
    BOOKING_ALREADY_FILLED = "BOOKING_ALREADY_FILLED",
    BOOKING_CANCELLED = "BOOKING_CANCELLED",
    BOOKING_EXPIRED = "BOOKING_EXPIRED",
    ASSIGNMENT_NOT_FOUND = "ASSIGNMENT_NOT_FOUND",
    DRIVER_ALREADY_ASSIGNED = "DRIVER_ALREADY_ASSIGNED",
    VEHICLE_ALREADY_ASSIGNED = "VEHICLE_ALREADY_ASSIGNED",
    TRACKING_NOT_FOUND = "TRACKING_NOT_FOUND",
    INVALID_LOCATION = "INVALID_LOCATION",
    VALIDATION_ERROR = "VALIDATION_ERROR",
    INTERNAL_ERROR = "INTERNAL_ERROR",
    NOT_FOUND = "NOT_FOUND",
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
}
//# sourceMappingURL=error.types.d.ts.map