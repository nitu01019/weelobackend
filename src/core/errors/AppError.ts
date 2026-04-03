/**
 * =============================================================================
 * APPLICATION ERROR CLASSES
 * =============================================================================
 *
 * Re-exports AppError from shared/types/error.types.ts (single source of truth)
 * and defines domain-specific error subclasses.
 *
 * USAGE:
 * ```typescript
 * // In service
 * throw new NotFoundError('Booking not found', ErrorCode.BOOKING_NOT_FOUND);
 *
 * // In route handler
 * throw new ValidationError('Invalid phone number', { field: 'phone' });
 * ```
 *
 * =============================================================================
 */

import { ErrorCode, HTTP_STATUS } from '../constants';

// Re-export AppError from the canonical shared location
export { AppError } from '../../shared/types/error.types';
import { AppError } from '../../shared/types/error.types';

/**
 * Error response format
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
    stack?: string;
  };
}

// =============================================================================
// SPECIFIC ERROR CLASSES
// =============================================================================

/**
 * 400 Bad Request - Invalid input
 */
export class BadRequestError extends AppError {
  constructor(
    message: string = 'Bad request',
    code: ErrorCode | string = ErrorCode.VALIDATION_ERROR,
    details?: Record<string, unknown>
  ) {
    super(HTTP_STATUS.BAD_REQUEST, code, message, details);
  }
}

/**
 * 400 Validation Error - Schema/input validation failed
 */
export class ValidationError extends AppError {
  public readonly errors: ValidationErrorDetail[];

  constructor(
    message: string = 'Validation failed',
    errors: ValidationErrorDetail[] = [],
    code: ErrorCode | string = ErrorCode.VALIDATION_ERROR
  ) {
    super(HTTP_STATUS.BAD_REQUEST, code, message, { errors });
    this.errors = errors;
  }

  static fromZodError(zodError: { errors: Array<{ path: (string | number)[]; message: string }> }): ValidationError {
    const errors = zodError.errors.map(err => ({
      field: err.path.join('.'),
      message: err.message
    }));
    return new ValidationError('Validation failed', errors);
  }
}

export interface ValidationErrorDetail {
  field: string;
  message: string;
  value?: unknown;
}

/**
 * 401 Unauthorized - Authentication required or failed
 */
export class UnauthorizedError extends AppError {
  constructor(
    message: string = 'Unauthorized',
    code: ErrorCode | string = ErrorCode.AUTH_TOKEN_INVALID
  ) {
    super(HTTP_STATUS.UNAUTHORIZED, code, message);
  }
}

/**
 * 403 Forbidden - Authenticated but not allowed
 */
export class ForbiddenError extends AppError {
  constructor(
    message: string = 'Access forbidden',
    code: ErrorCode | string = 'FORBIDDEN'
  ) {
    super(HTTP_STATUS.FORBIDDEN, code, message);
  }
}

/**
 * 404 Not Found - Resource doesn't exist
 */
export class NotFoundError extends AppError {
  constructor(
    message: string = 'Resource not found',
    code: ErrorCode | string = 'NOT_FOUND',
    details?: Record<string, unknown>
  ) {
    super(HTTP_STATUS.NOT_FOUND, code, message, details);
  }
}

/**
 * 409 Conflict - Resource already exists or state conflict
 */
export class ConflictError extends AppError {
  constructor(
    message: string = 'Resource conflict',
    code: ErrorCode | string = 'CONFLICT',
    details?: Record<string, unknown>
  ) {
    super(HTTP_STATUS.CONFLICT, code, message, details);
  }
}

/**
 * 422 Unprocessable Entity - Valid syntax but can't process
 */
export class UnprocessableError extends AppError {
  constructor(
    message: string = 'Cannot process request',
    code: ErrorCode | string = 'UNPROCESSABLE',
    details?: Record<string, unknown>
  ) {
    super(HTTP_STATUS.UNPROCESSABLE, code, message, details);
  }
}

/**
 * 429 Too Many Requests - Rate limited
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(
    message: string = 'Too many requests',
    retryAfter: number = 60
  ) {
    super(HTTP_STATUS.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMIT_EXCEEDED, message, { retryAfter });
    this.retryAfter = retryAfter;
  }
}

/**
 * 500 Internal Server Error - Unexpected error
 */
export class InternalError extends AppError {
  constructor(
    message: string = 'Internal server error',
    code: ErrorCode | string = ErrorCode.INTERNAL_ERROR,
    details?: Record<string, unknown>
  ) {
    super(HTTP_STATUS.INTERNAL_ERROR, code, message, details);
  }
}

/**
 * 503 Service Unavailable - Dependency down
 */
export class ServiceUnavailableError extends AppError {
  constructor(
    message: string = 'Service temporarily unavailable',
    code: ErrorCode | string = ErrorCode.SERVICE_UNAVAILABLE,
    details?: Record<string, unknown>
  ) {
    super(HTTP_STATUS.SERVICE_UNAVAILABLE, code, message, details);
  }
}

// =============================================================================
// DOMAIN-SPECIFIC ERRORS
// =============================================================================

/**
 * Authentication-specific errors
 */
export class AuthenticationError extends UnauthorizedError {
  constructor(message: string, code: ErrorCode = ErrorCode.AUTH_INVALID_CREDENTIALS) {
    super(message, code);
  }
}

export class TokenExpiredError extends UnauthorizedError {
  constructor() {
    super('Token has expired', ErrorCode.AUTH_TOKEN_EXPIRED);
  }
}

export class InvalidOTPError extends BadRequestError {
  constructor(attemptsRemaining?: number) {
    super(
      'Invalid OTP',
      ErrorCode.AUTH_OTP_INVALID,
      attemptsRemaining !== undefined ? { attemptsRemaining } : undefined
    );
  }
}

export class OTPExpiredError extends BadRequestError {
  constructor() {
    super('OTP has expired', ErrorCode.AUTH_OTP_EXPIRED);
  }
}

/**
 * Booking-specific errors
 */
export class BookingNotFoundError extends NotFoundError {
  constructor(bookingId: string) {
    super(`Booking not found: ${bookingId}`, ErrorCode.BOOKING_NOT_FOUND, { bookingId });
  }
}

export class InvalidBookingStatusError extends BadRequestError {
  constructor(currentStatus: string, attemptedAction: string) {
    super(
      `Cannot ${attemptedAction} booking in status: ${currentStatus}`,
      ErrorCode.BOOKING_INVALID_STATUS,
      { currentStatus, attemptedAction }
    );
  }
}

/**
 * Vehicle-specific errors
 */
export class VehicleNotFoundError extends NotFoundError {
  constructor(vehicleId: string) {
    super(`Vehicle not found: ${vehicleId}`, ErrorCode.VEHICLE_NOT_FOUND, { vehicleId });
  }
}

export class VehicleNotAvailableError extends ConflictError {
  constructor(vehicleId: string, reason?: string) {
    super(
      reason || 'Vehicle is not available',
      ErrorCode.VEHICLE_NOT_AVAILABLE,
      { vehicleId }
    );
  }
}

/**
 * Driver-specific errors
 */
export class DriverNotFoundError extends NotFoundError {
  constructor(driverId: string) {
    super(`Driver not found: ${driverId}`, ErrorCode.DRIVER_NOT_FOUND, { driverId });
  }
}

export class DriverNotAvailableError extends ConflictError {
  constructor(driverId: string) {
    super('Driver is not available', ErrorCode.DRIVER_NOT_AVAILABLE, { driverId });
  }
}

// =============================================================================
// ERROR TYPE GUARDS
// =============================================================================

/**
 * Check if error is an operational (expected) error
 */
export function isOperationalError(error: unknown): error is AppError {
  return error instanceof AppError && error.isOperational;
}

/**
 * Check if error is a specific type
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}
