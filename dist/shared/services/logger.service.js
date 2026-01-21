"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logDebug = exports.logWarn = exports.logError = exports.logInfo = exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
const environment_1 = require("../../config/environment");
// Define log format
const logFormat = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.printf(({ level, message, timestamp, stack, ...meta }) => {
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
}));
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
function sanitizeLogData(data) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        // Check if key contains sensitive field name
        const isSensitive = SENSITIVE_FIELDS.some(field => key.toLowerCase().includes(field.toLowerCase()));
        if (isSensitive) {
            sanitized[key] = '[REDACTED]';
        }
        else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeLogData(value);
        }
        else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
// Create logger instance
exports.logger = winston_1.default.createLogger({
    level: environment_1.config.logLevel,
    format: logFormat,
    transports: [
        // Console transport
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), logFormat)
        }),
        // File transport for errors (production)
        ...(environment_1.config.isProduction ? [
            new winston_1.default.transports.File({
                filename: 'logs/error.log',
                level: 'error',
                maxsize: 5242880, // 5MB
                maxFiles: 5
            }),
            new winston_1.default.transports.File({
                filename: 'logs/combined.log',
                maxsize: 5242880,
                maxFiles: 5
            })
        ] : [])
    ]
});
// Export convenience methods
const logInfo = (message, meta) => exports.logger.info(message, meta);
exports.logInfo = logInfo;
const logError = (message, error) => {
    if (error instanceof Error) {
        exports.logger.error(message, { error: error.message, stack: error.stack });
    }
    else {
        exports.logger.error(message, { error });
    }
};
exports.logError = logError;
const logWarn = (message, meta) => exports.logger.warn(message, meta);
exports.logWarn = logWarn;
const logDebug = (message, meta) => exports.logger.debug(message, meta);
exports.logDebug = logDebug;
//# sourceMappingURL=logger.service.js.map