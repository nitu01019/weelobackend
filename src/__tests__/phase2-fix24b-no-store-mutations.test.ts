/**
 * =============================================================================
 * Phase-2 Fix #24b — Cache-Control: no-store on POST/PUT/PATCH/DELETE mutations
 * =============================================================================
 *
 * Estela #24b (Zoe Z6 2026-05-11): a global `noStoreOnMutations` middleware
 * MUST emit `Cache-Control: no-store, no-cache, must-revalidate, private`
 * on POST/PUT/PATCH/DELETE responses so intermediaries (mobile-app HTTP
 * cache, ELB, ISP transparent proxies on 4G) cannot replay cached 201/200
 * mutation responses.
 *
 * Verification (Solution L6502):
 *   (a) POST → no-store header set
 *   (b) GET → handler-emitted `private, max-age=300` is NOT overridden
 *   (c) PUT/PATCH/DELETE → no-store header set
 *
 * Uses the project's native test pattern (express + raw http module) —
 * no supertest dependency.
 * =============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';

import { noStoreOnMutations } from '../shared/middleware/security.middleware';

type HttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

function createTestApp(): express.Express {
  const app = express();
  app.use(noStoreOnMutations);

  app.post('/mut', (_req: Request, res: Response) => {
    res.status(201).json({ ok: true });
  });
  app.put('/put', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  app.patch('/patch', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  app.delete('/del', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // GET handler that emits the existing Cache-Control pattern used by
  // profile.routes.ts:76 + customer.routes.ts:47/77/107. The middleware
  // MUST NOT override this since `MUTATION_METHODS.has('GET')` is false.
  app.get('/get', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).json({ ok: true });
  });

  // OPTIONS handler (CORS preflight surface). The middleware should NOT
  // set Cache-Control for OPTIONS — preflight caching via
  // Access-Control-Max-Age must remain intact.
  app.options('/mut', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  app.use(
    (err: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  );

  return app;
}

function makeRequest(
  app: express.Express,
  method: string,
  path: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            server.close();
            let parsed: any;
            try {
              parsed = data ? JSON.parse(data) : null;
            } catch {
              parsed = data;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<
                string,
                string | string[] | undefined
              >,
              body: parsed,
            });
          });
        }
      );
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

describe('Phase-2 Fix #24b — noStoreOnMutations middleware', () => {
  const app = createTestApp();
  const EXPECTED_NO_STORE = 'no-store, no-cache, must-revalidate, private';

  describe('(a) POST mutations emit no-store', () => {
    it('POST /mut → Cache-Control = no-store, no-cache, must-revalidate, private', async () => {
      const res = await makeRequest(app, 'POST', '/mut');
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe(EXPECTED_NO_STORE);
    });
  });

  describe('(b) GET handler-emitted Cache-Control is preserved', () => {
    it('GET /get → existing private, max-age=300 is NOT overridden by the middleware', async () => {
      const res = await makeRequest(app, 'GET', '/get');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, max-age=300');
    });
  });

  describe('(c) All mutation methods (PUT, PATCH, DELETE) emit no-store', () => {
    it.each([
      ['PUT', '/put'],
      ['PATCH', '/patch'],
      ['DELETE', '/del'],
    ])('%s %s → Cache-Control = %s', async (method, path) => {
      const res = await makeRequest(app, method, path);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe(EXPECTED_NO_STORE);
    });
  });

  describe('(d) CORS preflight (OPTIONS) is excluded', () => {
    it('OPTIONS /mut → middleware does NOT set Cache-Control', async () => {
      const res = await makeRequest(app, 'OPTIONS', '/mut');
      // OPTIONS is intentionally excluded from MUTATION_METHODS so
      // Access-Control-Max-Age preflight caching remains intact.
      expect(res.headers['cache-control']).toBeUndefined();
    });
  });
});
