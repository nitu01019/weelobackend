/**
 * =============================================================================
 * F-A-11 — Layered rate-limit keyGenerator (RED test)
 * =============================================================================
 *
 * Expected behavior (FF_LAYERED_RATE_LIMIT_KEY=true):
 *   - req.user.id set              → key = "u:<id>"
 *   - valid X-Device-Id header     → key = "d:<deviceId>"
 *   - IP is in trustedProxyCidrs   → key = "ip:<ip>"
 *   - otherwise                    → key = "spoof-slow:<ip>"
 *
 * When flag is OFF, legacy behavior preserved: userId → "user:<id>", else req.ip.
 *
 * Verifies F-A-08 prerequisites are wired: isInCidrList + trustedProxyCidrs.
 *
 * Source-level assertions (test must match runtime behavior):
 *   - keyGenerator imports isInCidrList
 *   - keyGenerator checks x-device-id header with /^[a-zA-Z0-9-_]{8,64}$/
 *   - "spoof-slow:" prefix is emitted for untrusted IPs
 *   - metric `rate_limit_key_source_total` is incremented
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

const MIDDLEWARE_PATH = path.resolve(
  __dirname,
  '../shared/middleware/rate-limiter.middleware.ts',
);
const FLAGS_PATH = path.resolve(
  __dirname,
  '../shared/config/feature-flags.ts',
);

function readSource(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

describe('F-A-11: Layered rate-limit keyGenerator', () => {
  let middlewareSrc: string;
  let flagsSrc: string;

  beforeAll(() => {
    middlewareSrc = readSource(MIDDLEWARE_PATH);
    flagsSrc = readSource(FLAGS_PATH);
  });

  // -------------------------------------------------------------------------
  // 1. Feature flag registered
  // -------------------------------------------------------------------------
  describe('feature flag registry', () => {
    it('registers FF_LAYERED_RATE_LIMIT_KEY as a release toggle', () => {
      expect(flagsSrc).toContain('FF_LAYERED_RATE_LIMIT_KEY');
      // The flag must be a 'release' category (default OFF).
      const flagBlock = flagsSrc.substring(
        flagsSrc.indexOf('FF_LAYERED_RATE_LIMIT_KEY'),
        flagsSrc.indexOf('FF_LAYERED_RATE_LIMIT_KEY') + 400,
      );
      // Either as a property name or as an env string.
      expect(flagBlock).toMatch(/category:\s*['"]release['"]/);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Middleware source wiring
  // -------------------------------------------------------------------------
  describe('keyGenerator source wiring', () => {
    it('imports isInCidrList from net.utils', () => {
      expect(middlewareSrc).toMatch(
        /import\s*\{[^}]*isInCidrList[^}]*\}\s*from\s*['"][^'"]*net\.utils['"]/,
      );
    });

    it('imports FLAGS / isEnabled from feature-flags', () => {
      expect(middlewareSrc).toMatch(
        /from\s*['"][^'"]*feature-flags['"]/,
      );
    });

    it('references FF_LAYERED_RATE_LIMIT_KEY (either as env string or FLAGS key)', () => {
      // Either `FLAGS.LAYERED_RATE_LIMIT_KEY` or direct env lookup works.
      expect(middlewareSrc).toMatch(
        /LAYERED_RATE_LIMIT_KEY|FF_LAYERED_RATE_LIMIT_KEY/,
      );
    });

    it('emits "u:" prefix for authenticated users under the layered path', () => {
      expect(middlewareSrc).toContain('`u:${');
    });

    it('emits "d:" prefix for device-id-keyed requests', () => {
      expect(middlewareSrc).toContain('`d:${');
    });

    it('emits "ip:" prefix for trusted proxy IPs', () => {
      expect(middlewareSrc).toContain('`ip:${');
    });

    it('emits "spoof-slow:" prefix for untrusted IP sources', () => {
      expect(middlewareSrc).toContain('spoof-slow:');
    });

    it('validates x-device-id against /^[a-zA-Z0-9-_]{8,64}$/', () => {
      // The regex must appear in source so untrusted input cannot be used as a key.
      expect(middlewareSrc).toMatch(/\[a-zA-Z0-9\-_\]\{8,64\}/);
    });

    it('emits rate_limit_key_source_total metric', () => {
      expect(middlewareSrc).toContain('rate_limit_key_source_total');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Runtime behavior — flag OFF (legacy shared bucket)
  // -------------------------------------------------------------------------
  describe('runtime: FF_LAYERED_RATE_LIMIT_KEY=false (legacy)', () => {
    const originalFlag = process.env.FF_LAYERED_RATE_LIMIT_KEY;

    beforeEach(() => {
      jest.resetModules();
      process.env.FF_LAYERED_RATE_LIMIT_KEY = 'false';
    });
    afterEach(() => {
      if (originalFlag === undefined) delete process.env.FF_LAYERED_RATE_LIMIT_KEY;
      else process.env.FF_LAYERED_RATE_LIMIT_KEY = originalFlag;
    });

    it('exposes layeredKeyGenerator for direct testing', () => {
      const mod = require('../shared/middleware/rate-limiter.middleware');
      expect(typeof mod.layeredKeyGenerator).toBe('function');
    });

    it('legacy: two requests same IP with different deviceIds share the same bucket', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const a = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: { 'x-device-id': 'device-aaaaaaaa' },
        user: undefined,
      } as any);
      const b = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: { 'x-device-id': 'device-bbbbbbbb' },
        user: undefined,
      } as any);
      expect(a).toBe(b);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Runtime behavior — flag ON (layered)
  // -------------------------------------------------------------------------
  describe('runtime: FF_LAYERED_RATE_LIMIT_KEY=true (layered)', () => {
    const originalFlag = process.env.FF_LAYERED_RATE_LIMIT_KEY;
    const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;

    beforeEach(() => {
      jest.resetModules();
      process.env.FF_LAYERED_RATE_LIMIT_KEY = 'true';
      process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/16';
    });
    afterEach(() => {
      if (originalFlag === undefined) delete process.env.FF_LAYERED_RATE_LIMIT_KEY;
      else process.env.FF_LAYERED_RATE_LIMIT_KEY = originalFlag;
      if (originalCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
      else process.env.TRUSTED_PROXY_CIDRS = originalCidrs;
    });

    it('userId present → returns u:<id>', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const key = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: {},
        user: { id: 'user-abc' },
      } as any);
      expect(key).toBe('u:user-abc');
    });

    it('valid deviceId in header → returns d:<deviceId>', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const key = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: { 'x-device-id': 'device-abcdef12' },
        user: undefined,
      } as any);
      expect(key).toBe('d:device-abcdef12');
    });

    it('same IP but DIFFERENT deviceIds produce DISTINCT buckets', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const a = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: { 'x-device-id': 'device-aaaaaaaa' },
        user: undefined,
      } as any);
      const b = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: { 'x-device-id': 'device-bbbbbbbb' },
        user: undefined,
      } as any);
      expect(a).not.toBe(b);
    });

    it('malformed/short deviceId is rejected, falls back to IP path', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const key = layeredKeyGenerator({
        ip: '10.0.0.5',
        headers: { 'x-device-id': 'bad' /* too short */ },
        user: undefined,
      } as any);
      // Falls back to ip: (10.0.0.5 is in trusted CIDR)
      expect(key).toBe('ip:10.0.0.5');
    });

    it('trusted IP with no user, no deviceId → ip:<ip>', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const key = layeredKeyGenerator({
        ip: '10.0.0.7',
        headers: {},
        user: undefined,
      } as any);
      expect(key).toBe('ip:10.0.0.7');
    });

    it('untrusted IP (outside trusted CIDRs) → spoof-slow:<ip>', () => {
      const { layeredKeyGenerator } = require('../shared/middleware/rate-limiter.middleware');
      const key = layeredKeyGenerator({
        ip: '203.0.113.7',
        headers: {},
        user: undefined,
      } as any);
      expect(key).toBe('spoof-slow:203.0.113.7');
    });
  });
});
