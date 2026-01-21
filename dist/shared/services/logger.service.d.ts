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
export declare const logger: winston.Logger;
export declare const logInfo: (message: string, meta?: Record<string, unknown>) => winston.Logger;
export declare const logError: (message: string, error?: unknown) => void;
export declare const logWarn: (message: string, meta?: Record<string, unknown>) => winston.Logger;
export declare const logDebug: (message: string, meta?: Record<string, unknown>) => winston.Logger;
//# sourceMappingURL=logger.service.d.ts.map