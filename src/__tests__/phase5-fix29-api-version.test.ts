/**
 * =============================================================================
 * PHASE 5 — FIX #29 — Accept-Version two-phase deploy contract (PREP PR)
 * =============================================================================
 *
 * Validates the apiVersionMiddleware that reads Accept-Version (preferred) or
 * X-API-Version (alias) and normalises onto req.apiVersion. On v1 it emits
 * Deprecation/Sunset/Link headers per RFC 8594 + RFC 5988. The canonical
 * server CORS block must expose those headers via Access-Control-Expose-Headers.
 *
 * Coverage (verify clauses a-e from index-30-validated.md L7944):
 *   (a) Accept-Version=v2 → req.apiVersion='v2', no Deprecation header,
 *       api_version_request_total{version=v2} incremented.
 *   (b) Absent or 'v1' → req.apiVersion='v1', Deprecation+Sunset+Link headers
 *       set, api_version_request_total{version=v1} incremented.
 *   (c) Duplicate header `Accept-Version: v1, Accept-Version: v2` (Node 18+
 *       comma-joins to a string) → req.apiVersion='v1' (allowlist-rejects
 *       'v1, v2' as unknown → safe fallback to v1).
 *   (d) Garbage 'vfoo' → req.apiVersion='v1' + metric {version:'unknown'} +
 *       warn log fires.
 *   (e) CORS preflight: Access-Control-Expose-Headers contains Deprecation,
 *       Sunset, Link, Idempotent-Replayed, Retry-After, X-Request-ID,
 *       RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset.
 *   (f) Calendar fix: Sunset header is `Thu, 31 Dec 2026 23:59:59 GMT`
 *       (Thursday — Dec 31 2026 — NOT Saturday).
 *
 * Uses the project's native test pattern (express + raw http module) — mirrors
 * phase5-fix8-idempotency-key.test.ts.
 * =============================================================================
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import net from 'net';

import { apiVersionMiddleware } from '../shared/middleware/api-version.middleware';
import { metrics } from '../shared/monitoring/metrics.service';
import { logger } from '../shared/services/logger.service';

type HttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

// -----------------------------------------------------------------------------
// Helper: read a counter's label-keyed value out of the metrics registry.
// -----------------------------------------------------------------------------
function getCounterValue(name: string, labels: Record<string, string>): number {
  const counter = (metrics as unknown as {
    counters: Map<string, { labels: Record<string, number> }>;
  }).counters.get(name);
  if (!counter) return 0;
  // Mirror MetricsService.labelsToKey: alpha-sorted keys, value wrapped in
  // double-quotes, comma-joined. See src/shared/monitoring/metrics.service.ts:729.
  const labelKey = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return counter.labels[labelKey] ?? 0;
}

// -----------------------------------------------------------------------------
// Builds a minimal Express app that mounts apiVersionMiddleware behind the
// SAME CORS configuration as server.ts so preflight assertions are realistic.
// -----------------------------------------------------------------------------
function createTestApp(): express.Express {
  const app = express();

  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-ID',
        'X-Trace-ID',
        'X-Load-Test-Run-Id',
        'X-Device-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
        'Accept-Version',
        'X-API-Version',
      ],
      exposedHeaders: [
        'Deprecation',
        'Sunset',
        'Link',
        'Idempotent-Replayed',
        'Retry-After',
        'X-Request-ID',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
      ],
    })
  );

  app.use(apiVersionMiddleware);

  app.get('/echo', (req: Request, res: Response) => {
    res.status(200).json({ apiVersion: req.apiVersion ?? null });
  });

  return app;
}

// -----------------------------------------------------------------------------
// Raw-HTTP request builder — lets the test emit DUPLICATE Accept-Version
// header lines (Node concatenates with ", " into the string Express surfaces).
// -----------------------------------------------------------------------------
function rawRequest(
  app: express.Express,
  method: string,
  path: string,
  headerLines: Array<[string, string]>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('failed to bind test server'));
        return;
      }
      const port = addr.port;
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        let raw = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n`;
        for (const [name, value] of headerLines) {
          raw += `${name}: ${value}\r\n`;
        }
        raw += `Content-Length: 0\r\n\r\n`;
        sock.write(raw);
      });

      let buf = '';
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
      });
      sock.on('end', () => {
        server.close();
        const [head, body = ''] = buf.split('\r\n\r\n');
        const lines = head.split('\r\n');
        const statusLine = lines[0] ?? '';
        const status = Number(statusLine.split(' ')[1] ?? 0);
        const headers: Record<string, string | string[] | undefined> = {};
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const idx = line.indexOf(':');
          if (idx < 0) continue;
          const name = line.slice(0, idx).trim().toLowerCase();
          const value = line.slice(idx + 1).trim();
          const prev = headers[name];
          if (prev === undefined) {
            headers[name] = value;
          } else if (Array.isArray(prev)) {
            prev.push(value);
          } else {
            headers[name] = [prev, value];
          }
        }
        resolve({ status, headers, body });
      });
      sock.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
    });
  });
}

// -----------------------------------------------------------------------------
// (a) (b) (c) (d) UNIT tests — direct middleware invocation against fake req/res.
// Fast, deterministic, no socket bind. Avoids cross-test flakiness on the
// shared `metrics` counter registry.
// -----------------------------------------------------------------------------
function makeReq(headers: Record<string, string | string[] | undefined> = {}): Request {
  const lowered: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  return { headers: lowered } as unknown as Request;
}

function makeRes(): {
  res: Response;
  outHeaders: Record<string, string | string[]>;
} {
  const outHeaders: Record<string, string | string[]> = {};
  const res = {
    setHeader: (name: string, value: string | string[]): void => {
      outHeaders[name.toLowerCase()] = value;
    },
    append: (name: string, value: string | string[]): void => {
      const key = name.toLowerCase();
      const prev = outHeaders[key];
      if (prev === undefined) {
        outHeaders[key] = value;
      } else if (Array.isArray(prev) && Array.isArray(value)) {
        outHeaders[key] = [...prev, ...value];
      } else if (Array.isArray(prev)) {
        outHeaders[key] = [...prev, value as string];
      } else if (Array.isArray(value)) {
        outHeaders[key] = [prev as string, ...value];
      } else {
        outHeaders[key] = [prev as string, value as string];
      }
    },
  } as unknown as Response;
  return { res, outHeaders };
}

describe('Phase 5 Fix #29 — apiVersionMiddleware (unit)', () => {
  describe('(a) Accept-Version=v2', () => {
    it('sets req.apiVersion="v2", does NOT emit Deprecation/Sunset/Link', () => {
      const before = getCounterValue('api_version_request_total', { version: 'v2' });
      const req = makeReq({ 'Accept-Version': 'v2' });
      const { res, outHeaders } = makeRes();
      let nextCalled = false;
      apiVersionMiddleware(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(req.apiVersion).toBe('v2');
      expect(outHeaders['deprecation']).toBeUndefined();
      expect(outHeaders['sunset']).toBeUndefined();
      expect(outHeaders['link']).toBeUndefined();
      const after = getCounterValue('api_version_request_total', { version: 'v2' });
      expect(after).toBe(before + 1);
    });
  });

  describe('(b) absent header → default v1', () => {
    it('sets req.apiVersion="v1" and emits Deprecation+Sunset+Link', () => {
      const before = getCounterValue('api_version_request_total', { version: 'v1' });
      const req = makeReq({});
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(req.apiVersion).toBe('v1');
      expect(outHeaders['deprecation']).toBe('true');
      // (f) calendar fix — Thursday, NOT Saturday.
      expect(outHeaders['sunset']).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
      expect(String(outHeaders['link'])).toContain('rel="successor-version"');
      expect(String(outHeaders['link'])).toContain('rel="deprecation"');
      const after = getCounterValue('api_version_request_total', { version: 'v1' });
      expect(after).toBe(before + 1);
    });

    it('X-API-Version=v1 → same v1 behaviour', () => {
      const req = makeReq({ 'X-API-Version': 'v1' });
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(req.apiVersion).toBe('v1');
      expect(outHeaders['deprecation']).toBe('true');
    });

    it('Accept-Version takes precedence over X-API-Version when both present', () => {
      const req = makeReq({
        'Accept-Version': 'v2',
        'X-API-Version': 'v1',
      });
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(req.apiVersion).toBe('v2');
      expect(outHeaders['deprecation']).toBeUndefined();
    });
  });

  describe('(c) duplicate header — Node comma-joins to a string', () => {
    it('rejects "v1, v2" via allowlist → safe fallback to v1', () => {
      const before = getCounterValue('api_version_request_total', { version: 'unknown' });
      const req = makeReq({ 'Accept-Version': 'v1, v2' });
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(req.apiVersion).toBe('v1');
      expect(outHeaders['deprecation']).toBe('true');
      // "v1, v2" lowercases/trims to "v1, v2" which is not in the allowlist → unknown.
      const after = getCounterValue('api_version_request_total', { version: 'unknown' });
      expect(after).toBe(before + 1);
    });

    it('Array.isArray narrows when Express surfaces an array (HTTP/2 surface)', () => {
      const req = makeReq({ 'Accept-Version': ['v2', 'v1'] });
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      // First-value extraction: 'v2' wins, no Deprecation emitted.
      expect(req.apiVersion).toBe('v2');
      expect(outHeaders['deprecation']).toBeUndefined();
    });
  });

  describe('(d) garbage version → unknown metric + warn log', () => {
    it('Accept-Version="vfoo" → req.apiVersion="v1" + metric {version:"unknown"} + warn', () => {
      const before = getCounterValue('api_version_request_total', { version: 'unknown' });
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
      const req = makeReq({ 'Accept-Version': 'vfoo' });
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(req.apiVersion).toBe('v1');
      expect(outHeaders['deprecation']).toBe('true');
      expect(warnSpy).toHaveBeenCalledWith(
        '[APIVersion] unknown version header',
        expect.objectContaining({ received: 'vfoo' }),
      );
      const after = getCounterValue('api_version_request_total', { version: 'unknown' });
      expect(after).toBe(before + 1);
      warnSpy.mockRestore();
    });

    it('truncates long garbage header to 16 chars in the warn log', () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
      const long = 'v' + 'x'.repeat(64);
      const req = makeReq({ 'Accept-Version': long });
      const { res } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(warnSpy).toHaveBeenCalledWith(
        '[APIVersion] unknown version header',
        expect.objectContaining({ received: long.slice(0, 16) }),
      );
      warnSpy.mockRestore();
    });

    it('case-insensitive — Accept-Version="V1" still normalises to v1 (not unknown)', () => {
      const beforeV1 = getCounterValue('api_version_request_total', { version: 'v1' });
      const req = makeReq({ 'Accept-Version': 'V1' });
      const { res, outHeaders } = makeRes();
      apiVersionMiddleware(req, res, () => {});
      expect(req.apiVersion).toBe('v1');
      expect(outHeaders['deprecation']).toBe('true');
      const afterV1 = getCounterValue('api_version_request_total', { version: 'v1' });
      expect(afterV1).toBe(beforeV1 + 1);
    });
  });
});

// -----------------------------------------------------------------------------
// (e) (f) INTEGRATION tests — real Express + raw HTTP through a CORS preflight
// and a regular GET, asserting the wire-level Sunset literal and the CORS
// Access-Control-Expose-Headers list.
// -----------------------------------------------------------------------------
describe('Phase 5 Fix #29 — apiVersionMiddleware (integration via raw HTTP)', () => {
  it('(e) OPTIONS preflight exposes Deprecation/Sunset/Link + #6/#7 headers + RateLimit-*', async () => {
    const app = createTestApp();
    const resp = await rawRequest(app, 'OPTIONS', '/echo', [
      ['Origin', 'https://client.example'],
      ['Access-Control-Request-Method', 'GET'],
      ['Access-Control-Request-Headers', 'Accept-Version'],
    ]);
    expect(resp.status).toBe(204);
    const expose = String(resp.headers['access-control-expose-headers'] ?? '');
    for (const required of [
      'Deprecation',
      'Sunset',
      'Link',
      'Idempotent-Replayed',
      'Retry-After',
      'X-Request-ID',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ]) {
      expect(expose).toContain(required);
    }
    // Negative — IETF draft RateLimit-* family; legacy X-RateLimit-* MUST NOT
    // be listed (server uses standardHeaders:true and does not emit X- form).
    expect(expose).not.toContain('X-RateLimit-Limit');
  });

  it('(f) GET emits Sunset header equal to "Thu, 31 Dec 2026 23:59:59 GMT" (calendar fix)', async () => {
    const app = createTestApp();
    const resp = await rawRequest(app, 'GET', '/echo', []);
    expect(resp.status).toBe(200);
    expect(resp.headers['sunset']).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
    expect(resp.headers['deprecation']).toBe('true');
    expect(String(resp.headers['link'])).toContain('rel="successor-version"');
  });

  it('GET with Accept-Version=v2 → response has NO Deprecation/Sunset/Link', async () => {
    const app = createTestApp();
    const resp = await rawRequest(app, 'GET', '/echo', [['Accept-Version', 'v2']]);
    expect(resp.status).toBe(200);
    expect(resp.headers['deprecation']).toBeUndefined();
    expect(resp.headers['sunset']).toBeUndefined();
    expect(resp.headers['link']).toBeUndefined();
    expect(JSON.parse(resp.body)).toEqual({ apiVersion: 'v2' });
  });
});
