/**
 * =============================================================================
 * PHASE 5 — FIX #8 — Idempotency-Key dual-accept (IETF bare + X-prefix legacy)
 * =============================================================================
 *
 * Validates the centralised helper at src/shared/utils/idempotency-key.helper.ts
 * which is the single source of truth for reading the client-supplied
 * idempotency key off an Express request.
 *
 * Coverage:
 *   (a) Bare `Idempotency-Key` wins precedence over legacy `X-Idempotency-Key`
 *   (b) Legacy `X-Idempotency-Key` is still accepted (RFC 6648 backward-compat)
 *   (c) Header name lookup is case-insensitive (Express lowercases all headers)
 *   (d) Exactly 255-char accepted; 256-char rejected (IETF draft-07 §2 1*256 VCHAR cap)
 *   (e) VCHAR charset (0x21-0x7E) rejects emoji, NUL, DEL (0x7F), embedded space, lone surrogate
 *   (f) RFC 7230 §3.2.2 comma-joined dup-header rejected (single header value containing comma)
 *   (g) RFC 7540 §8.1.2.5 multi-value array form rejected (HTTP/2 surface)
 *   (h) Supertest-style integration: two `Idempotency-Key` lines on real Express POST →
 *       Node concatenates with comma, helper returns undefined, echoed key never contains comma
 *   (i) CORS preflight: both `Idempotency-Key` and `X-Idempotency-Key` are allowed
 *
 * Uses the project's native test pattern (express + raw http module) — no
 * supertest dependency, mirrors phase2-fix24b-no-store-mutations.test.ts.
 * =============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';
import net from 'net';
import cors from 'cors';

import {
  readIdempotencyKey,
  echoIdempotencyKey,
} from '../shared/utils/idempotency-key.helper';

type HttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

// -----------------------------------------------------------------------------
// Unit-level: Request mocks for the helper itself (fast, deterministic).
// -----------------------------------------------------------------------------
function makeReq(headers: Record<string, string | string[] | undefined> = {}): Request {
  const lowered: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  return { headers: lowered } as unknown as Request;
}

describe('Phase 5 Fix #8 — readIdempotencyKey (unit)', () => {
  describe('(a) bare wins precedence', () => {
    it('returns bare value when both headers present', () => {
      const req = makeReq({
        'Idempotency-Key': 'bare-value',
        'X-Idempotency-Key': 'legacy-value',
      });
      expect(readIdempotencyKey(req)).toBe('bare-value');
    });
  });

  describe('(b) legacy X-prefix backward-compat', () => {
    it('returns X-prefixed value when only legacy is present', () => {
      const req = makeReq({ 'X-Idempotency-Key': 'legacy-only' });
      expect(readIdempotencyKey(req)).toBe('legacy-only');
    });

    it('falls through to legacy when bare is missing', () => {
      const req = makeReq({ 'x-idempotency-key': 'lowercase-legacy' });
      expect(readIdempotencyKey(req)).toBe('lowercase-legacy');
    });
  });

  describe('(c) case-insensitive header name', () => {
    it('accepts lowercase header name (Express delivers headers lowercase)', () => {
      const req = makeReq({ 'idempotency-key': 'lower-bare' });
      expect(readIdempotencyKey(req)).toBe('lower-bare');
    });

    it('accepts mixed-case input (case-folded by helper before lookup)', () => {
      const req = makeReq({ 'Idempotency-Key': 'mixed-bare' });
      expect(readIdempotencyKey(req)).toBe('mixed-bare');
    });
  });

  describe('(d) length boundaries', () => {
    it('accepts exactly 255 chars', () => {
      const key = 'a'.repeat(255);
      const req = makeReq({ 'Idempotency-Key': key });
      expect(readIdempotencyKey(req)).toBe(key);
    });

    it('rejects 256 chars (> IETF draft-07 §2 cap)', () => {
      const key = 'a'.repeat(256);
      const req = makeReq({ 'Idempotency-Key': key });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects blank (length 0 after trim)', () => {
      const req = makeReq({ 'Idempotency-Key': '   ' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects empty string', () => {
      const req = makeReq({ 'Idempotency-Key': '' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });
  });

  describe('(e) VCHAR (0x21-0x7E) charset enforcement', () => {
    it('rejects emoji (surrogate pair, outside ASCII)', () => {
      const req = makeReq({ 'Idempotency-Key': 'key-\u{1F600}-tail' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects NUL (0x00, below VCHAR)', () => {
      const req = makeReq({ 'Idempotency-Key': 'key-\x00-tail' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects DEL (0x7F, above VCHAR)', () => {
      const req = makeReq({ 'Idempotency-Key': 'key-\x7F-tail' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects embedded space (0x20, below VCHAR)', () => {
      const req = makeReq({ 'Idempotency-Key': 'key with space' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects lone high-surrogate', () => {
      const req = makeReq({ 'Idempotency-Key': 'key-\uD83D-tail' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('rejects CR/LF (0x0D, 0x0A — RFC 7230 §3.2.4)', () => {
      const req = makeReq({ 'Idempotency-Key': 'key-\r\n-injected' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('accepts canonical UUID v4 (within VCHAR)', () => {
      const req = makeReq({ 'Idempotency-Key': '550e8400-e29b-41d4-a716-446655440000' });
      expect(readIdempotencyKey(req)).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('accepts base64url chars (- _ . ~ within VCHAR)', () => {
      const req = makeReq({ 'Idempotency-Key': 'abc-def_ghi.jkl~mno' });
      expect(readIdempotencyKey(req)).toBe('abc-def_ghi.jkl~mno');
    });
  });

  describe('(f) RFC 7230 §3.2.2 — duplicate-header comma-join refusal', () => {
    it('returns undefined when value contains a comma (dup-header concat)', () => {
      const req = makeReq({ 'Idempotency-Key': 'first-key, second-key' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('returns undefined for trailing comma alone', () => {
      const req = makeReq({ 'Idempotency-Key': 'key,' });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('falls through to legacy when bare has comma but legacy is clean', () => {
      const req = makeReq({
        'Idempotency-Key': 'first,second',
        'X-Idempotency-Key': 'clean-legacy',
      });
      expect(readIdempotencyKey(req)).toBe('clean-legacy');
    });
  });

  describe('(g) RFC 7540 §8.1.2.5 — HTTP/2 multi-value array form refusal', () => {
    it('returns undefined when header is delivered as array', () => {
      const req = makeReq({ 'Idempotency-Key': ['first', 'second'] });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('returns undefined for single-element array (still ambiguous surface)', () => {
      const req = makeReq({ 'Idempotency-Key': ['only-one'] });
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('falls through to legacy when bare is array form but legacy is string', () => {
      const req = makeReq({
        'Idempotency-Key': ['first', 'second'],
        'X-Idempotency-Key': 'legacy-clean',
      });
      expect(readIdempotencyKey(req)).toBe('legacy-clean');
    });
  });

  describe('missing / undefined', () => {
    it('returns undefined when neither header is present', () => {
      const req = makeReq({});
      expect(readIdempotencyKey(req)).toBeUndefined();
    });

    it('trims surrounding whitespace and accepts the inner value', () => {
      const req = makeReq({ 'Idempotency-Key': '  trimmed-key  ' });
      expect(readIdempotencyKey(req)).toBe('trimmed-key');
    });
  });
});

describe('Phase 5 Fix #8 — echoIdempotencyKey (unit)', () => {
  it('sets both canonical and legacy header on the response', () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (n: string, v: string) => {
        headers[n.toLowerCase()] = String(v);
      },
    } as unknown as Response;
    echoIdempotencyKey(res, 'abc-123');
    expect(headers['idempotency-key']).toBe('abc-123');
    expect(headers['x-idempotency-key']).toBe('abc-123');
  });
});

// -----------------------------------------------------------------------------
// Integration: real Express + raw HTTP — closes mock-vs-real gap (Attack 19).
// -----------------------------------------------------------------------------
function createTestApp(): express.Express {
  const app = express();

  // Mirror server.ts CORS allow-list — both header names allowed.
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ],
    })
  );

  app.use(express.json());

  // Echo handler — pulls the key via the helper and echoes it back on the response.
  app.post('/echo', (req: Request, res: Response) => {
    const key = readIdempotencyKey(req);
    if (key) echoIdempotencyKey(res, key);
    res.status(200).json({ ok: true, key: key ?? null });
  });

  app.use(
    (err: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  );

  return app;
}

type HeaderTuple = [string, string];

function makeRequest(
  app: express.Express,
  method: string,
  path: string,
  headerTuples: HeaderTuple[] = []
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      // Build raw HTTP request manually so we can emit DUPLICATE header lines —
      // Node's `req.setHeader` collapses to a single value, defeating the
      // RFC 7230 §3.2.2 dup-header reproducer (Attack 7).
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        let raw = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n`;
        for (const [name, value] of headerTuples) {
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
          const existing = headers[name];
          if (existing === undefined) {
            headers[name] = value;
          } else if (Array.isArray(existing)) {
            existing.push(value);
          } else {
            headers[name] = [existing as string, value];
          }
        }
        let parsed: any;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          parsed = body;
        }
        resolve({ status, headers, body: parsed });
      });
      sock.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe('Phase 5 Fix #8 — Express integration (real HTTP)', () => {
  const app = createTestApp();

  describe('happy paths echo the key', () => {
    it('POST with bare Idempotency-Key → echoed in both canonical and legacy headers', async () => {
      const res = await makeRequest(app, 'POST', '/echo', [
        ['Idempotency-Key', '550e8400-e29b-41d4-a716-446655440000'],
      ]);
      expect(res.status).toBe(200);
      expect(res.body.key).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(res.headers['idempotency-key']).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(res.headers['x-idempotency-key']).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('POST with legacy X-Idempotency-Key only → still echoed', async () => {
      const res = await makeRequest(app, 'POST', '/echo', [
        ['X-Idempotency-Key', 'legacy-uuid'],
      ]);
      expect(res.status).toBe(200);
      expect(res.body.key).toBe('legacy-uuid');
      expect(res.headers['idempotency-key']).toBe('legacy-uuid');
      expect(res.headers['x-idempotency-key']).toBe('legacy-uuid');
    });

    it('bare wins when both sent on same request', async () => {
      const res = await makeRequest(app, 'POST', '/echo', [
        ['Idempotency-Key', 'wins'],
        ['X-Idempotency-Key', 'loses'],
      ]);
      expect(res.body.key).toBe('wins');
    });
  });

  describe('(h) Attack 7 reproducer — RFC 7230 §3.2.2 duplicate-header concat', () => {
    it('two `Idempotency-Key` lines on real Express POST → echoed key never contains comma', async () => {
      const res = await makeRequest(app, 'POST', '/echo', [
        ['Idempotency-Key', 'first-uuid-aaaaaaaa-bbbb-4ccc-aaaa-eeeeeeeeeeee'],
        ['Idempotency-Key', 'second-uuid-ffffffff-aaaa-4ccc-aaaa-jjjjjjjjjjjj'],
      ]);
      expect(res.status).toBe(200);
      const echoed =
        (res.headers['idempotency-key'] as string | undefined) ||
        (res.headers['x-idempotency-key'] as string | undefined) ||
        '';
      expect(echoed).not.toContain(',');
      // Helper rejects ambiguity → no key echoed; handler reports null
      expect(res.body.key).toBeNull();
    });

    it('two `X-Idempotency-Key` lines also rejected', async () => {
      const res = await makeRequest(app, 'POST', '/echo', [
        ['X-Idempotency-Key', 'first'],
        ['X-Idempotency-Key', 'second'],
      ]);
      expect(res.body.key).toBeNull();
    });
  });

  describe('(i) CORS preflight allow-list', () => {
    it('OPTIONS preflight permits Idempotency-Key in Access-Control-Allow-Headers', async () => {
      const res = await makeRequest(app, 'OPTIONS', '/echo', [
        ['Origin', 'https://example.com'],
        ['Access-Control-Request-Method', 'POST'],
        ['Access-Control-Request-Headers', 'Idempotency-Key'],
      ]);
      // cors() echoes the requested headers when they're in the allow-list.
      const allowed = String(
        res.headers['access-control-allow-headers'] ?? ''
      ).toLowerCase();
      expect(allowed).toContain('idempotency-key');
    });

    it('OPTIONS preflight permits X-Idempotency-Key in Access-Control-Allow-Headers', async () => {
      const res = await makeRequest(app, 'OPTIONS', '/echo', [
        ['Origin', 'https://example.com'],
        ['Access-Control-Request-Method', 'POST'],
        ['Access-Control-Request-Headers', 'X-Idempotency-Key'],
      ]);
      const allowed = String(
        res.headers['access-control-allow-headers'] ?? ''
      ).toLowerCase();
      expect(allowed).toContain('x-idempotency-key');
    });

    it('OPTIONS preflight permits BOTH header names in a single request', async () => {
      const res = await makeRequest(app, 'OPTIONS', '/echo', [
        ['Origin', 'https://example.com'],
        ['Access-Control-Request-Method', 'POST'],
        ['Access-Control-Request-Headers', 'Idempotency-Key, X-Idempotency-Key'],
      ]);
      const allowed = String(
        res.headers['access-control-allow-headers'] ?? ''
      ).toLowerCase();
      expect(allowed).toContain('idempotency-key');
      expect(allowed).toContain('x-idempotency-key');
    });
  });
});
