/**
 * =============================================================================
 * API VERSION MIDDLEWARE  (Fix #29 — Accept-Version two-phase deploy contract)
 * =============================================================================
 *
 * Reads Accept-Version (preferred) or X-API-Version (alias) and normalises the
 * client's requested API version onto req.apiVersion. Default 'v1' when absent
 * or unrecognised. On v1 emits Deprecation+Sunset+Link headers per RFC 8594
 * + RFC 5988 so clients (and proxies) can discover the 90-day sunset window.
 *
 * Hardening (CWE-20): req.headers[*] is `string | string[] | undefined` —
 * Express joins duplicate request headers into a comma-separated string at
 * Node 18+, but a custom server (or a downstream proxy) MAY surface an
 * array. Narrow with Array.isArray before lowercase/trim.
 *
 * Mount: server.ts — immediately AFTER backwardCompatMiddleware and BEFORE
 * the /api/v1 route blocks so req.apiVersion is populated for every handler.
 *
 * The canonical metrics export at metrics.service.ts is `metrics` (NOT
 * `metricsService`). Rename-on-import keeps the call-site reading naturally.
 * =============================================================================
 */

import type { Request, Response, NextFunction } from 'express';
import { metrics as metricsService } from '../monitoring/metrics.service';
import { logger } from '../services/logger.service';

const SUNSET_HTTP_DATE = process.env.SUNSET_DATE_HTTP_DATE ?? 'Thu, 31 Dec 2026 23:59:59 GMT';
const SUCCESSOR_DOCS_URL =
  process.env.API_DEPRECATION_DOCS_URL ?? 'https://docs.weelo.example/api/deprecations';
const ALLOWED_VERSIONS: ReadonlySet<string> = new Set(['v1', 'v2']);

export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers['accept-version'] ?? req.headers['x-api-version'];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  const normalized = typeof headerValue === 'string' ? headerValue.toLowerCase().trim() : 'v1';
  const version: 'v1' | 'v2' = ALLOWED_VERSIONS.has(normalized) ? (normalized as 'v1' | 'v2') : 'v1';

  if (typeof headerValue === 'string' && !ALLOWED_VERSIONS.has(normalized)) {
    metricsService.incrementCounter('api_version_request_total', { version: 'unknown' });
    logger.warn('[APIVersion] unknown version header', { received: headerValue.slice(0, 16) });
  } else {
    metricsService.incrementCounter('api_version_request_total', { version });
  }

  req.apiVersion = version;

  if (version === 'v1') {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', SUNSET_HTTP_DATE);
    res.append(
      'Link',
      `</api/v2>; rel="successor-version", ` +
        `<${SUCCESSOR_DOCS_URL}>; rel="deprecation"; type="text/html"`,
    );
  }
  next();
}
