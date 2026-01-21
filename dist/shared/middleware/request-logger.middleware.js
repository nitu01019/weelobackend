"use strict";
/**
 * =============================================================================
 * REQUEST LOGGER MIDDLEWARE
 * =============================================================================
 *
 * Logs all incoming requests for debugging and audit purposes.
 *
 * SECURITY:
 * - Does not log request bodies (may contain sensitive data)
 * - Does not log authorization headers
 * - Masks sensitive query parameters
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
const logger_service_1 = require("../services/logger.service");
// Query params to mask in logs
const SENSITIVE_PARAMS = ['token', 'key', 'secret', 'password', 'otp'];
/**
 * Mask sensitive query parameters
 */
function maskQueryParams(query) {
    const masked = {};
    for (const [key, value] of Object.entries(query)) {
        const isSensitive = SENSITIVE_PARAMS.some(param => key.toLowerCase().includes(param));
        masked[key] = isSensitive ? '[MASKED]' : value;
    }
    return masked;
}
/**
 * Request logger middleware
 */
function requestLogger(req, res, next) {
    const startTime = Date.now();
    // Log when response finishes
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logData = {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            userAgent: req.get('user-agent')?.substring(0, 100), // Truncate long user agents
            ...(Object.keys(req.query).length > 0 && {
                query: maskQueryParams(req.query)
            })
        };
        // Log level based on status code
        if (res.statusCode >= 500) {
            logger_service_1.logger.error('Request failed', logData);
        }
        else if (res.statusCode >= 400) {
            logger_service_1.logger.warn('Request error', logData);
        }
        else {
            logger_service_1.logger.info('Request completed', logData);
        }
    });
    next();
}
//# sourceMappingURL=request-logger.middleware.js.map