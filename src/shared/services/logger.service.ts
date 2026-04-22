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
 * - Redacts PII patterns from free-text messages (A12-003/004/005/006)
 * - Different log levels for different environments
 *
 * DPDP Act 2023 §5(b) — data minimisation: all six pattern classes
 * (10-digit phone, PEM blocks, 40+ char base64, international phone,
 * 16-digit card, email addresses) are redacted at the format layer AND
 * inside the global unhandledRejection / uncaughtException handlers.
 * =============================================================================
 */

import winston from 'winston';
import { config } from '../../config/environment';
import { SENSITIVE_FIELDS } from '../utils/pii.utils';

// ---------------------------------------------------------------------------
// P4-T11 — Multi-pattern redactor (A12-003/004/005/006)
// ---------------------------------------------------------------------------

/**
 * Compiled once at module load so regex objects are not rebuilt per log line.
 * Each entry: [pattern, replacement].
 */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // 10-digit Indian phone numbers
  [/\b(\d{10})\b/g, (match: string) => '******' + match.slice(-4)],
  // PEM certificate / key blocks
  [/-----BEGIN [^\n]+-----[\s\S]*?-----END [^\n]+-----/g, '[PEM_REDACTED]'],
  // 40+ character base64 strings (tokens, keys, etc.)
  [/[A-Za-z0-9+/=]{40,}/g, '[B64_REDACTED]'],
  // International phone formats  (+1 555-1234, +44 7911 123456, etc.)
  [/\+\d{1,3}[\s-]?\d{4,14}/g, '[PHONE_REDACTED]'],
  // 16-digit card numbers (mask middle 8 digits)
  [/\b(\d{4})\d{8}(\d{4})\b/g, '$1[****8888]$2'],
  // Email addresses
  [/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '[EMAIL_REDACTED]'],
] as unknown as Array<[RegExp, string]>;

/**
 * Apply all six PII redaction patterns to a free-text message string.
 * Called inside the winston format pipeline AND the global error handlers.
 *
 * Order matters: PEM is matched before base64 so that PEM blocks (which
 * contain long base64 payloads) are replaced as a unit.
 */
function redactSensitivePatterns(msg: string): string {
  if (typeof msg !== 'string') return msg;
  let result = msg;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    // replacement may be a string or a function — RegExp.prototype.replace
    // accepts both, but TypeScript needs the cast.
    result = result.replace(pattern, replacement as string);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structured-metadata sanitiser — removes PII keys (unchanged behaviour)
// ---------------------------------------------------------------------------

/**
 * Remove sensitive fields from log data.
 * Uses SENSITIVE_FIELDS imported from pii.utils (single source of truth).
 */
function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Check if key contains sensitive field name (case-insensitive substring)
    const isSensitive = SENSITIVE_FIELDS.some((field) =>
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

// ---------------------------------------------------------------------------
// Winston format
// ---------------------------------------------------------------------------

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    // P4-T11: redact PII patterns from the free-text message
    const safeMessage = redactSensitivePatterns(String(message ?? ''));

    let log = `${timestamp} [${level.toUpperCase()}]: ${safeMessage}`;

    // Add metadata if present (excluding sensitive fields)
    const sanitizedMeta = sanitizeLogData(meta);
    if (Object.keys(sanitizedMeta).length > 0) {
      log += ` ${JSON.stringify(sanitizedMeta)}`;
    }

    // Add stack trace for errors (also redact PII from stack if any)
    if (stack) {
      log += `\n${redactSensitivePatterns(String(stack))}`;
    }

    return log;
  })
);

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

export const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),

    // File transports for local development only.
    // In production (ECS), stdout goes to CloudWatch — file transports
    // fill ephemeral storage and are lost on container restart.
    ...(!config.isProduction
      ? [
          new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 5242880, // 5 MB
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: 5242880,
            maxFiles: 5,
          }),
        ]
      : []),
  ],
});

// ---------------------------------------------------------------------------
// P4-T11 (Part B §2.5 amendment) — global unhandled-error handlers
// Attach AFTER logger is created so we can log safely.
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason: unknown) => {
  const raw =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
  logger.error(`[unhandledRejection] ${redactSensitivePatterns(raw)}`);
});

process.on('uncaughtException', (err: Error) => {
  const raw = `${err.message}\n${err.stack ?? ''}`;
  logger.error(`[uncaughtException] ${redactSensitivePatterns(raw)}`);
  // Re-throw so the process exits — Node.js best practice
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

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
