/**
 * =============================================================================
 * SERVER MIDDLEWARE SETUP
 * =============================================================================
 *
 * Extracted from server.ts (file-split).
 * Configures all Express middleware: security, compression, CORS, parsing,
 * request logging, metrics, and rate limiting.
 * =============================================================================
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { config } from './config/environment';
import { logger } from './shared/services/logger.service';
import { errorHandler } from './shared/middleware/error.middleware';
import { requestLogger } from './shared/middleware/request-logger.middleware';
import { rateLimiter } from './shared/middleware/rate-limiter.middleware';
import {
  requestIdMiddleware,
  securityHeaders,
  sanitizeInput,
  preventParamPollution,
  blockSuspiciousRequests,
  securityResponseHeaders
} from './shared/middleware/security.middleware';
import { metricsMiddleware } from './shared/monitoring/metrics.service';

/**
 * Apply all middleware to the Express app.
 * Order matters -- security first, then parsing, then logging, then rate limiting.
 */
export function applyMiddleware(app: express.Application): void {
  // Trust proxy - MUST be first before any middleware that uses req.ip
  app.set('trust proxy', 1);

  // Request ID for tracking (must be first)
  app.use(requestIdMiddleware);

  // GZIP Compression
  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    }
  }));

  // Security headers (Helmet)
  app.use(securityHeaders);
  app.use(securityResponseHeaders);

  // CORS
  const resolvedCorsOrigin = (() => {
    if (config.isDevelopment) return ['http://localhost:3000', 'http://localhost:5173'];
    if (config.cors.origin === '*' && config.isProduction) {
      logger.warn('[CORS] CORS_ORIGIN not set in production -- defaulting to restrictive.');
      return [] as string[];
    }
    return config.cors.origin;
  })();

  app.use(cors({
    origin: resolvedCorsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      'X-Trace-ID',
      'X-Load-Test-Run-Id'
    ],
    credentials: true,
    maxAge: 86400
  }));

  // Parse JSON bodies with size limit
  app.use(express.json({ limit: '1mb' }));

  // Block suspicious requests (XSS, SQL injection, etc.)
  app.use(blockSuspiciousRequests);

  // Sanitize all input
  app.use(sanitizeInput);

  // Prevent parameter pollution
  app.use(preventParamPollution);

  // Request logging
  app.use(requestLogger);

  // Metrics collection middleware
  app.use(metricsMiddleware);
}

/**
 * Apply rate limiter. Separated so health routes can be mounted BEFORE this.
 */
export function applyRateLimiter(app: express.Application): void {
  app.use(rateLimiter);
}

/**
 * Apply error-handling middleware (must be last).
 */
export function applyErrorHandlers(app: express.Application): void {
  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found'
      }
    });
  });

  // Global error handler
  app.use(errorHandler);
}
