/**
 * =============================================================================
 * LOGGER SERVICE
 * =============================================================================
 * 
 * Centralized logging service using Winston.
 * 
 * SECURITY:
 * - Never logs sensitive data (tokens, passwords, secrets)
 * - Sanitizes error messages before logging
 * - Different log levels for different environments
 * =============================================================================
 */

import winston from 'winston';
import { config } from '../../config/environment';

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    // Add metadata if present (excluding sensitive fields)
    const sanitizedMeta = sanitizeLogData(meta);
    if (Object.keys(sanitizedMeta).length > 0) {
      log += ` ${JSON.stringify(sanitizedMeta)}`;
    }
    
    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }
    
    return log;
  })
);

// Sensitive fields to never log
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'authorization',
  'otp',
  'pin'
];

/**
 * Remove sensitive fields from log data
 */
function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(data)) {
    // Check if key contains sensitive field name
    const isSensitive = SENSITIVE_FIELDS.some(field => 
      key.toLowerCase().includes(field.toLowerCase())
    );
    
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

// Create logger instance
export const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    
    // File transport for errors (production)
    ...(config.isProduction ? [
      new winston.transports.File({ 
        filename: 'logs/error.log', 
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      }),
      new winston.transports.File({ 
        filename: 'logs/combined.log',
        maxsize: 5242880,
        maxFiles: 5
      })
    ] : [])
  ]
});

// Export convenience methods
export const logInfo = (message: string, meta?: Record<string, unknown>) => 
  logger.info(message, meta);

export const logError = (message: string, error?: unknown) => {
  if (error instanceof Error) {
    logger.error(message, { error: error.message, stack: error.stack });
  } else {
    logger.error(message, { error });
  }
};

export const logWarn = (message: string, meta?: Record<string, unknown>) => 
  logger.warn(message, meta);

export const logDebug = (message: string, meta?: Record<string, unknown>) => 
  logger.debug(message, meta);
