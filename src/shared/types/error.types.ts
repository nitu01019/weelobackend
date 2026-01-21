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
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean = true;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    
    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation Error - 400
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

/**
 * Authentication Error - 401
 */
export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

/**
 * Authorization Error - 403
 */
export class AuthorizationError extends AppError {
  constructor(message: string = 'Permission denied') {
    super(403, 'FORBIDDEN', message);
  }
}

/**
 * Not Found Error - 404
 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

/**
 * Conflict Error - 409
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

/**
 * Rate Limit Error - 429
 */
export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests') {
    super(429, 'RATE_LIMIT_EXCEEDED', message);
  }
}

/**
 * Error codes enum for consistent error identification
 */
export enum ErrorCode {
  // Auth errors
  INVALID_PHONE = 'INVALID_PHONE',
  INVALID_OTP = 'INVALID_OTP',
  OTP_EXPIRED = 'OTP_EXPIRED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  
  // Booking errors
  BOOKING_NOT_FOUND = 'BOOKING_NOT_FOUND',
  BOOKING_ALREADY_FILLED = 'BOOKING_ALREADY_FILLED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
  BOOKING_EXPIRED = 'BOOKING_EXPIRED',
  
  // Assignment errors
  ASSIGNMENT_NOT_FOUND = 'ASSIGNMENT_NOT_FOUND',
  DRIVER_ALREADY_ASSIGNED = 'DRIVER_ALREADY_ASSIGNED',
  VEHICLE_ALREADY_ASSIGNED = 'VEHICLE_ALREADY_ASSIGNED',
  
  // Tracking errors
  TRACKING_NOT_FOUND = 'TRACKING_NOT_FOUND',
  INVALID_LOCATION = 'INVALID_LOCATION',
  
  // General errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED'
}
