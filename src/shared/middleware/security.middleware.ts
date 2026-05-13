/**
 * =============================================================================
 * SECURITY MIDDLEWARE
 * =============================================================================
 * 
 * Comprehensive security middleware for production-ready API.
 * 
 * SECURITY FEATURES:
 * - Helmet security headers
 * - Input sanitization (XSS, SQL injection prevention)
 * - Request size limiting
 * - CORS configuration
 * - Request ID tracking
 * 
 * SCALABILITY:
 * - Stateless design
 * - Low overhead
 * - Works with load balancers
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../services/logger.service';

/**
 * Generate and attach request ID for tracking
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = (req.headers['x-request-id'] as string)?.trim() || uuidv4();
  const traceId = (req.headers['x-trace-id'] as string)?.trim() || requestId;
  const loadTestRunId = (req.headers['x-load-test-run-id'] as string)?.trim();

  req.headers['x-request-id'] = requestId;
  req.headers['x-trace-id'] = traceId;
  if (loadTestRunId) {
    req.headers['x-load-test-run-id'] = loadTestRunId;
  }

  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Trace-ID', traceId);
  if (loadTestRunId) {
    res.setHeader('X-Load-Test-Run-Id', loadTestRunId);
  }

  next();
}

/**
 * Security headers using Helmet
 * Configurable for different environments
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for mobile apps
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
});

/**
 * Input sanitization middleware
 * Prevents XSS and injection attacks
 */
export function sanitizeInput(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    // Sanitize body
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }

    // Sanitize query params
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query) as typeof req.query;
    }

    // Sanitize params
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params);
    }

    next();
  } catch (error) {
    logger.error('Input sanitization error', error);
    next();
  }
}

/**
 * Recursively sanitize object values
 */
function sanitizeObject(obj: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item => 
        typeof item === 'string' ? sanitizeString(item) : 
        typeof item === 'object' ? sanitizeObject(item) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Sanitize string to prevent XSS
 * 
 * IMPORTANT: This sanitization is for preventing XSS attacks.
 * We should NOT escape HTML entities or remove quotes here because:
 * 1. This corrupts legitimate data (addresses, names with apostrophes)
 * 2. The data is already parsed JSON, not raw HTML
 * 3. Output encoding should happen at render time, not input time
 */
function sanitizeString(str: string): string {
  return str
    // Remove script tags (XSS prevention)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove on* event handlers (XSS prevention)
    .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '')
    // Remove javascript: URLs
    .replace(/javascript:/gi, '')
    // Trim whitespace
    .trim();
}

/**
 * Prevent parameter pollution
 */
export function preventParamPollution(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  // Convert array params to single value (take first)
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        req.query[key] = value[0];
      }
    }
  }
  next();
}

/**
 * Block suspicious requests
 */
export function blockSuspiciousRequests(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const suspiciousPatterns = [
    /\.\.\//,           // Path traversal
    /<script/i,         // XSS attempt
    /union.*select/i,   // SQL injection
    /exec\s*\(/i,       // Command injection
    /\$\{.*\}/,         // Template injection
  ];

  // Only check URL path + query params — NOT body (body check causes false positives
  // on legitimate data like addresses with special chars, template strings, etc.)
  const requestString = `${req.url} ${JSON.stringify(req.query)}`;

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(requestString)) {
      logger.warn('Blocked suspicious request', {
        ip: req.ip,
        url: req.url,
        pattern: pattern.toString(),
      });
      
      res.status(400).json({
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid request',
        },
      });
      return;
    }
  }

  next();
}

/**
 * Add security response headers
 */
export function securityResponseHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions policy
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self), microphone=(), camera=()'
  );

  next();
}

// =============================================================================
// Estela #24b (Zoe Z6 2026-05-11) — RFC 7234 §3 / §4.2.2: 201 Created and 200 OK
// responses to POST/PUT/PATCH/DELETE are heuristically cacheable by intermediaries
// (mobile-app HTTP cache, ELB, ISP transparent proxies on 4G) when no explicit
// Cache-Control directive is present. A cached 201 replayed offline could mislead
// the app into thinking a brand-new order was created — worse with the #6
// `Idempotent-Replayed` rollout where a cached 201 carrying `Idempotent-Replayed:
// false` (the original fresh response) tricks the captain/customer app into the
// "new order" branch when the request never reached origin.
//
// CORS preflight (OPTIONS) is intentionally excluded — the 204 No Content
// preflight is short-cached by the browser via Access-Control-Max-Age and
// setting no-store there would defeat preflight caching without security
// benefit.
// =============================================================================
const MUTATION_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function noStoreOnMutations(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (MUTATION_METHODS.has(req.method)) {
    // `no-store` covers private + shared caches; `must-revalidate` + `no-cache`
    // are belt-and-suspenders for non-conformant intermediaries seen in field
    // tests on Indian 4G carriers (ISP transparent proxies pre-2022 ignored
    // bare `no-store`).
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
  next();
}
