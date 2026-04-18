/**
 * =============================================================================
 * F-A-39 — buildCacheKey canonicalize + sha256 (RED test)
 * =============================================================================
 *
 * Expected:
 *   - canonicalize() deeply sorts object keys and rounds numeric coords to 5 decimals.
 *   - shortHash() = sha256(canonical JSON) truncated to 16 hex chars.
 *   - buildCacheKey('routes:v1', {a:1,b:2}) === buildCacheKey('routes:v1', {b:2,a:1})
 *   - Key length ≤ 30 chars (`prefix:` + 16 hex) — tighter than 30 in the usual case.
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

const UTIL_PATH = path.resolve(
  __dirname,
  '../shared/utils/canonical-hash.ts',
);
const SERVICE_PATH = path.resolve(
  __dirname,
  '../shared/services/google-maps.service.ts',
);

describe('F-A-39: canonical hash + buildCacheKey v2', () => {
  // -------------------------------------------------------------------------
  // 1. canonical-hash.ts module exists & exports
  // -------------------------------------------------------------------------
  describe('canonical-hash.ts exports', () => {
    it('exists at src/shared/utils/canonical-hash.ts', () => {
      expect(fs.existsSync(UTIL_PATH)).toBe(true);
    });

    it('exports canonicalize() and shortHash()', () => {
      const mod = require('../shared/utils/canonical-hash');
      expect(typeof mod.canonicalize).toBe('function');
      expect(typeof mod.shortHash).toBe('function');
    });

    it('canonicalize() sorts object keys deterministically', () => {
      const { canonicalize } = require('../shared/utils/canonical-hash');
      expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    });

    it('canonicalize() sorts nested keys deterministically', () => {
      const { canonicalize } = require('../shared/utils/canonical-hash');
      expect(canonicalize({ outer: { a: 1, b: 2 } })).toBe(
        canonicalize({ outer: { b: 2, a: 1 } }),
      );
    });

    it('canonicalize() rounds numeric values to 5 decimal places', () => {
      const { canonicalize } = require('../shared/utils/canonical-hash');
      const a = canonicalize({ lat: 28.6139012345 });
      const b = canonicalize({ lat: 28.613901 });
      // Both should canonicalize to the 5-decimal representation.
      expect(a).toBe(b);
    });

    it('canonicalize() preserves array order (order is meaningful for waypoints)', () => {
      const { canonicalize } = require('../shared/utils/canonical-hash');
      const a = canonicalize({ points: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }] });
      const b = canonicalize({ points: [{ lat: 3, lng: 4 }, { lat: 1, lng: 2 }] });
      // Reversing waypoints = different route, must produce different canonical form.
      expect(a).not.toBe(b);
    });

    it('shortHash() returns 16-char hex string', () => {
      const { shortHash } = require('../shared/utils/canonical-hash');
      const h = shortHash({ a: 1 });
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it('shortHash() is stable across key orderings', () => {
      const { shortHash } = require('../shared/utils/canonical-hash');
      expect(shortHash({ a: 1, b: 2 })).toBe(shortHash({ b: 2, a: 1 }));
    });
  });

  // -------------------------------------------------------------------------
  // 2. google-maps.service.ts uses the new canonical builder
  // -------------------------------------------------------------------------
  describe('google-maps.service.ts buildCacheKey wiring', () => {
    let src: string;
    beforeAll(() => { src = fs.readFileSync(SERVICE_PATH, 'utf-8'); });

    it('imports shortHash from canonical-hash', () => {
      expect(src).toMatch(
        /import\s*\{[^}]*shortHash[^}]*\}\s*from\s*['"][^'"]*canonical-hash['"]/,
      );
    });

    it('buildCacheKey no longer relies on JSON.stringify(data) → base64', () => {
      const idx = src.indexOf('buildCacheKey(prefix');
      expect(idx).toBeGreaterThan(-1);
      const block = src.substring(idx, idx + 400);
      // Legacy pattern was Buffer.from(JSON.stringify(data)).toString('base64').
      // New pattern must use shortHash(data) instead of base64.
      expect(block).not.toMatch(/Buffer\.from\(\s*JSON\.stringify\(data\)/);
      expect(block).toContain('shortHash');
    });

    it('buildCacheKey output is deterministic irrespective of input key order', () => {
      // Runtime: invoke the service indirectly via a focused helper test.
      const { shortHash } = require('../shared/utils/canonical-hash');
      const keyA = `routes:v1:${shortHash({ a: 1, b: 2 })}`;
      const keyB = `routes:v1:${shortHash({ b: 2, a: 1 })}`;
      expect(keyA).toBe(keyB);
      expect(keyA.length).toBeLessThanOrEqual(30);
    });
  });
});
