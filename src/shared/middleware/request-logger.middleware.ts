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

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';

// Query params to mask in logs
const SENSITIVE_PARAMS = ['token', 'key', 'secret', 'password', 'otp'];

/**
 * Mask sensitive query parameters
 */
function maskQueryParams(query: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(query)) {
    const isSensitive = SENSITIVE_PARAMS.some(param => 
      key.toLowerCase().includes(param)
    );
    masked[key] = isSensitive ? '[MASKED]' : value;
  }
  
  return masked;
}

/**
 * Request logger middleware
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
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
        query: maskQueryParams(req.query as Record<string, any>) 
      })
    };
    
    // Log level based on status code
    if (res.statusCode >= 500) {
      logger.error('Request failed', logData);
    } else if (res.statusCode >= 400) {
      logger.warn('Request error', logData);
    } else {
      logger.info('Request completed', logData);
    }
  });
  
  next();
}
