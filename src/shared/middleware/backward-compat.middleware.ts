/**
 * =============================================================================
 * BACKWARD COMPATIBILITY MIDDLEWARE  (BRK-4)
 * =============================================================================
 *
 * The Captain app's TripApiService.kt calls 7 endpoints under /trips/* but
 * NO /trips module exists in the backend. 4 of these endpoints are ACTIVELY
 * CALLED at runtime by OfflineSyncService and LiveTrackingScreen, causing 404s.
 *
 * This middleware silently rewrites legacy app paths to canonical backend paths.
 * It MUST be registered BEFORE the rate limiter and API routes in server.ts.
 *
 * Rewrite rules (first match wins):
 *   POST /api/v1/trips/:id/start       -> PUT  /api/v1/tracking/trip/:id/status
 *   POST /api/v1/trips/:id/complete    -> PUT  /api/v1/tracking/trip/:id/status
 *   POST /api/v1/trips/:id/cancel      -> PATCH /api/v1/assignments/:id/status
 *   POST /api/v1/trips/:id/location    -> POST /api/v1/tracking/update
 *   GET  /api/v1/trips/:id             -> GET  /api/v1/tracking/:id
 *   GET  /api/v1/trips/:id/tracking    -> GET  /api/v1/tracking/:id
 *   GET  /api/v1/trips/:id/route       -> GET  /api/v1/orders/:id/route
 *   PUT  /api/v1/tracking/trips/:id/reached-stop
 *                                       -> PUT  /api/v1/tracking/trip/:id/status
 *   /api/v1/tracking/trips/            -> /api/v1/tracking/trip/  (plural fix)
 *
 * Headers added on every rewrite (RFC 8594):
 *   Deprecation: true
 *   Sunset: Sat, 31 Dec 2026 23:59:59 GMT
 *
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';

// ---- types ----------------------------------------------------------------

interface RewriteRule {
  /** RegExp tested against req.path (no query string) */
  readonly pattern: RegExp;
  /** Replacement string -- may use $1, $2, etc. from pattern groups */
  readonly replace: string;
  /** If set, only match when req.method is one of these */
  readonly methods?: ReadonlyArray<string>;
  /** If set, override req.method after rewrite */
  readonly methodRewrite?: string;
}

// ---- rules (order matters -- first match wins) ----------------------------

const REWRITE_RULES: ReadonlyArray<RewriteRule> = [
  // 1. POST /api/v1/trips/:id/start -> PUT /api/v1/tracking/trip/:id/status
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)\/start$/,
    replace: '/api/v1/tracking/trip/$1/status',
    methods: ['POST'],
    methodRewrite: 'PUT',
  },

  // 2. POST /api/v1/trips/:id/complete -> PUT /api/v1/tracking/trip/:id/status
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)\/complete$/,
    replace: '/api/v1/tracking/trip/$1/status',
    methods: ['POST'],
    methodRewrite: 'PUT',
  },

  // 3. POST /api/v1/trips/:id/cancel -> PATCH /api/v1/assignments/:id/status
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)\/cancel$/,
    replace: '/api/v1/assignments/$1/status',
    methods: ['POST'],
    methodRewrite: 'PATCH',
  },

  // 4. POST /api/v1/trips/:id/location -> POST /api/v1/tracking/update
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)\/location$/,
    replace: '/api/v1/tracking/update',
    methods: ['POST'],
  },

  // 5. GET /api/v1/trips/:id/tracking -> GET /api/v1/tracking/:id
  //    (must come before the bare GET /api/v1/trips/:id rule)
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)\/tracking$/,
    replace: '/api/v1/tracking/$1',
    methods: ['GET'],
  },

  // 6. GET /api/v1/trips/:id/route -> GET /api/v1/orders/:id/route
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)\/route$/,
    replace: '/api/v1/orders/$1/route',
    methods: ['GET'],
  },

  // 7. GET /api/v1/trips/:id -> GET /api/v1/tracking/:id
  {
    pattern: /^\/api\/v1\/trips\/([^/]+)$/,
    replace: '/api/v1/tracking/$1',
    methods: ['GET'],
  },

  // 8. BRK-2: PUT /api/v1/tracking/trips/:id/reached-stop
  //            -> PUT /api/v1/tracking/trip/:id/status
  {
    pattern: /^\/api\/v1\/tracking\/trips\/([^/]+)\/reached-stop$/,
    replace: '/api/v1/tracking/trip/$1/status',
    methods: ['PUT'],
  },

  // 9. General plural normalisation: /api/v1/tracking/trips/ -> /api/v1/tracking/trip/
  {
    pattern: /^\/api\/v1\/tracking\/trips\//,
    replace: '/api/v1/tracking/trip/',
  },
];

// ---- RFC 8594 deprecation headers -----------------------------------------

const DEPRECATION_HEADERS: Readonly<Record<string, string>> = {
  Deprecation: 'true',
  Sunset: 'Sat, 31 Dec 2026 23:59:59 GMT',
};

// ---- middleware ------------------------------------------------------------

/**
 * Express middleware that rewrites legacy Captain-app paths to canonical
 * backend routes.  Must be mounted BEFORE the rate limiter and API router.
 */
export function backwardCompatMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalMethod = req.method;
  const originalUrl = req.url; // includes query string
  const path = req.path;       // without query string

  for (const rule of REWRITE_RULES) {
    // Skip if method filter is set and doesn't match
    if (rule.methods && !rule.methods.includes(req.method)) {
      continue;
    }

    if (!rule.pattern.test(path)) {
      continue;
    }

    // Build the rewritten path
    const rewrittenPath = path.replace(rule.pattern, rule.replace);

    // Preserve the original query string
    const queryIndex = originalUrl.indexOf('?');
    const queryString = queryIndex !== -1 ? originalUrl.slice(queryIndex) : '';

    // Apply rewrites
    req.url = rewrittenPath + queryString;

    if (rule.methodRewrite) {
      req.method = rule.methodRewrite;
    }

    // Set RFC 8594 deprecation headers on the response
    for (const [header, value] of Object.entries(DEPRECATION_HEADERS)) {
      res.setHeader(header, value);
    }

    logger.info(
      `[BackwardCompat] ${originalMethod} ${originalUrl} --> ${req.method} ${req.url}`,
    );

    // First match wins
    break;
  }

  next();
}
