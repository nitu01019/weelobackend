/**
 * =============================================================================
 * ERROR TYPES
 * =============================================================================
 *
 * Custom error classes for consistent error handling.
 * All operational errors should use AppError.
 * =============================================================================
 */

import { HTTP_STATUS } from '../../core/constants';
// Aliased import: this file already exports a string-enum `ErrorCode` below, so
// the numeric `ErrorCode` enum from core/constants is imported under an alias to
// avoid name collision. NumericErrorCode.BACKPRESSURE resolves to 'SYS_9013'.
import { ErrorCode as NumericErrorCode } from '../../core/constants';

/**
 * Application Error class
 * Use this for all known/expected errors
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean = true;
  public readonly timestamp: string;

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
    this.timestamp = new Date().toISOString();

    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);

    // Set prototype explicitly (TypeScript issue with extending Error)
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Convert error to JSON response format
   */
  toJSON() {
    return {
      success: false as const,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        timestamp: this.timestamp,
        ...(process.env.NODE_ENV === 'development' && { stack: this.stack })
      }
    };
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
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  BACKPRESSURE = 'BACKPRESSURE',     // NEW — pairs with SYS_9013 numeric code
}

/**
 * Backpressure error — 503 with Retry-After.
 *
 * CWE-209 (Information Exposure): the PUBLIC `message` is generic and MUST NOT
 * interpolate internal context (queue depth, cap, hostname, internal IDs). Such
 * data goes in `internalReason` + `internalMeta`, which the error middleware logs
 * server-side ONLY and never serializes into the client response body.
 *
 * Public wire contract:
 *   HTTP 503
 *   Retry-After: <seconds>
 *   { success: false, error: { code: 'BACKPRESSURE', message: 'Service temporarily unavailable. Please retry shortly.' } }
 */
export interface BackpressureDetails extends Record<string, unknown> {
  /** Integer seconds — SAFE to expose; becomes the Retry-After header value. */
  retryAfter: number;
}

export class BackpressureError extends AppError {
  /** Server-side only — never reaches the client response body. */
  public readonly internalReason: string;
  /** Server-side only — never reaches the client response body. */
  public readonly internalMeta: Record<string, unknown>;

  constructor(
    internalReason: string,
    details: BackpressureDetails = { retryAfter: 5 },
    internalMeta: Record<string, unknown> = {},
    options?: { cause?: unknown }
  ) {
    super(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      NumericErrorCode.BACKPRESSURE,
      'Service temporarily unavailable. Please retry shortly.',
      details
    );
    this.internalReason = internalReason;
    this.internalMeta = internalMeta;
    if (options?.cause !== undefined) {
      // ES2022 Error.cause — preserves root-cause chain for server-side debugging.
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
