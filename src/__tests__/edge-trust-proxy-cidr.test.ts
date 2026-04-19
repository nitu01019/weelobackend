/**
 * =============================================================================
 * F-A-08 — Trust-proxy CIDR allowlist
 * =============================================================================
 *
 * Verifies Express honours TRUSTED_PROXY_CIDRS as a CIDR-based trusted-proxy
 * list instead of the spoofable numeric hop-count (`trust proxy = 1`).
 *
 * Under hop-count: a request from an UNTRUSTED source IP that prepends
 *   X-Forwarded-For: 1.2.3.4
 * and then traverses one proxy sees `req.ip === '1.2.3.4'` — an attacker can
 * mint a new spoofed XFF value per request to evade per-IP rate limiting.
 *
 * After the fix: `app.set('trust proxy', config.trustedProxyCidrs)` means
 * Express only strips XFF entries coming from configured CIDRs. When the
 * socket peer is outside the trusted list, XFF is ignored and `req.ip`
 * falls back to the socket address — the spoof fails.
 *
 * RED assertions:
 *  - req.ip is NOT '1.2.3.4' when the connection's socket is 127.0.0.1
 *    (which is OUTSIDE the default 10.0.0.0/16,172.16.0.0/12 CIDRs).
 *  - req.ip falls back to the socket (loopback) address.
 *  - getClientIpChain() helper returns { sources: ['1.2.3.4'], final: socketIp }.
 *  - config.trustedProxyCidrs is an array of CIDRs from TRUSTED_PROXY_CIDRS.
 *
 * Pattern: Node http helper (matches pricing-routes-integration.test.ts)
 * =============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { config } from '../config/environment';
import { getClientIpChain, isInCidrList } from '../shared/utils/net.utils';

type HttpResponse = {
  status: number;
  body: any;
};

function createTestApp(): express.Express {
  const app = express();
  // Apply the same trust-proxy config the production server.ts uses.
  // If the fix is applied, this is the CIDR list; if not, it's `1`.
  app.set('trust proxy', (config as any).trustedProxyCidrs ?? 1);
  app.use(express.json());

  app.get('/debug/ip', (req: Request, res: Response) => {
    const chain = getClientIpChain(req);
    res.json({
      ip: req.ip,
      socketIp: req.socket.remoteAddress,
      xff: req.headers['x-forwarded-for'] ?? null,
      chain,
    });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });

  return app;
}

function makeRequest(
  app: express.Express,
  path: string,
  headers: Record<string, string>
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers,
        },
        (res: any) => {
          let data = '';
          res.on('data', (c: string) => { data += c; });
          res.on('end', () => {
            server.close();
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on('error', (err: Error) => { server.close(); reject(err); });
      req.end();
    });
  });
}

describe('F-A-08 — trust-proxy CIDR allowlist', () => {
  describe('config.trustedProxyCidrs is exposed on the environment config', () => {
    it('exposes trustedProxyCidrs as a non-empty array', () => {
      const cidrs = (config as any).trustedProxyCidrs;
      expect(Array.isArray(cidrs)).toBe(true);
      expect(cidrs.length).toBeGreaterThan(0);
    });

    it('includes the default 10.0.0.0/16 and 172.16.0.0/12 AWS VPC CIDRs', () => {
      const cidrs: string[] = (config as any).trustedProxyCidrs;
      expect(cidrs).toEqual(expect.arrayContaining(['10.0.0.0/16', '172.16.0.0/12']));
    });
  });

  describe('X-Forwarded-For spoofing from an UNTRUSTED source IP is ignored', () => {
    it('req.ip does NOT equal the spoofed XFF value when socket is 127.0.0.1 (outside CIDR)', async () => {
      const app = createTestApp();
      const response = await makeRequest(app, '/debug/ip', {
        'X-Forwarded-For': '1.2.3.4',
      });

      expect(response.status).toBe(200);
      // Socket is 127.0.0.1 — NOT inside 10.0.0.0/16 or 172.16.0.0/12.
      // Therefore XFF MUST be rejected.
      expect(response.body.ip).not.toBe('1.2.3.4');
      // The XFF header was received — we just didn't trust it.
      expect(response.body.xff).toBe('1.2.3.4');
    });

    it('req.ip falls back to the loopback socket address', async () => {
      const app = createTestApp();
      const response = await makeRequest(app, '/debug/ip', {
        'X-Forwarded-For': '1.2.3.4',
      });

      expect(response.status).toBe(200);
      // IPv4 loopback may appear as '127.0.0.1' or IPv4-mapped '::ffff:127.0.0.1'
      expect(String(response.body.ip)).toMatch(/127\.0\.0\.1/);
    });
  });

  describe('getClientIpChain() helper returns the XFF sources and final resolved IP', () => {
    it('returns the XFF chain as sources and socket IP as final when XFF is untrusted', async () => {
      const app = createTestApp();
      const response = await makeRequest(app, '/debug/ip', {
        'X-Forwarded-For': '1.2.3.4, 5.6.7.8',
      });

      expect(response.status).toBe(200);
      expect(response.body.chain.sources).toEqual(['1.2.3.4', '5.6.7.8']);
      expect(String(response.body.chain.final)).toMatch(/127\.0\.0\.1/);
    });

    it('returns empty sources array when no X-Forwarded-For header is present', async () => {
      const app = createTestApp();
      const response = await makeRequest(app, '/debug/ip', {});
      expect(response.status).toBe(200);
      expect(response.body.chain.sources).toEqual([]);
      expect(response.body.chain.final).toBeTruthy();
    });
  });

  describe('isInCidrList() helper', () => {
    it('returns true for an IP inside 10.0.0.0/16', () => {
      expect(isInCidrList('10.0.12.34', ['10.0.0.0/16'])).toBe(true);
    });

    it('returns false for an IP outside 10.0.0.0/16', () => {
      expect(isInCidrList('1.2.3.4', ['10.0.0.0/16'])).toBe(false);
    });

    it('returns true for an IP inside 172.16.0.0/12', () => {
      expect(isInCidrList('172.16.5.5', ['172.16.0.0/12'])).toBe(true);
      expect(isInCidrList('172.31.200.1', ['172.16.0.0/12'])).toBe(true);
    });

    it('returns false for an empty CIDR list', () => {
      expect(isInCidrList('10.0.0.1', [])).toBe(false);
    });

    it('tolerates IPv4-mapped IPv6 addresses like ::ffff:10.0.0.1', () => {
      expect(isInCidrList('::ffff:10.0.0.1', ['10.0.0.0/16'])).toBe(true);
    });

    it('returns false for malformed IPs rather than throwing', () => {
      expect(isInCidrList('not-an-ip', ['10.0.0.0/16'])).toBe(false);
      expect(isInCidrList('', ['10.0.0.0/16'])).toBe(false);
    });

    it('returns false for malformed CIDRs rather than throwing', () => {
      expect(isInCidrList('10.0.0.1', ['not-a-cidr'])).toBe(false);
    });
  });
});
