/**
 * F-B-05 — Presence TTL SSOT invariant + migration grep test.
 *
 * Guards:
 *  1) HEARTBEAT/TTL derivation invariant (driver TTL > 2x heartbeat).
 *  2) All presence TTL literals in `src/` have been migrated to the SSOT file —
 *     no remaining `const PRESENCE_TTL_SECONDS = <number>` anywhere except the
 *     canonical `src/shared/config/presence.config.ts`.
 */

import * as path from 'path';
import * as fs from 'fs';

describe('F-B-05 presence TTL SSOT', () => {
  describe('invariant', () => {
    it('DRIVER_PRESENCE_TTL_SECONDS > 2 * HEARTBEAT_INTERVAL_SECONDS', () => {
      // Import late so env-driven parse runs with test env.
      const cfg = require('../shared/config/presence.config');
      expect(cfg.DRIVER_PRESENCE_TTL_SECONDS).toBeGreaterThan(
        2 * cfg.HEARTBEAT_INTERVAL_SECONDS,
      );
    });

    it('exposes canonical driver and transporter TTLs', () => {
      const cfg = require('../shared/config/presence.config');
      // Defaults: heartbeat=12 → driver=36, transporter=60.
      expect(cfg.HEARTBEAT_INTERVAL_SECONDS).toBe(12);
      expect(cfg.DRIVER_PRESENCE_TTL_SECONDS).toBe(36);
      expect(cfg.TRANSPORTER_PRESENCE_TTL_SECONDS).toBe(60);
    });
  });

  describe('invariant throws on misconfig', () => {
    const originalEnv = process.env.PRESENCE_HEARTBEAT_INTERVAL_SECONDS;

    afterEach(() => {
      jest.resetModules();
      if (originalEnv === undefined) delete process.env.PRESENCE_HEARTBEAT_INTERVAL_SECONDS;
      else process.env.PRESENCE_HEARTBEAT_INTERVAL_SECONDS = originalEnv;
    });

    it('throws at import time when heartbeat * 3 <= heartbeat * 2', () => {
      // heartbeat=0 → TTL=0; 0 > 0 is false → invariant throws.
      jest.resetModules();
      process.env.PRESENCE_HEARTBEAT_INTERVAL_SECONDS = '0';
      expect(() => require('../shared/config/presence.config')).toThrow(
        /invariant violated/,
      );
    });
  });

  describe('migration: no numeric literal TTLs remain', () => {
    const LITERAL_RE = /const\s+PRESENCE_TTL_SECONDS\s*=\s*\d+/;
    const SRC = path.resolve(__dirname, '..');
    const CANONICAL_FILE = path.resolve(
      __dirname,
      '../shared/config/presence.config.ts',
    );

    function* walk(dir: string): Generator<string> {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          yield* walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          yield path.join(dir, entry.name);
        }
      }
    }

    it('no file in src/ declares `const PRESENCE_TTL_SECONDS = <number>` (outside canonical config)', () => {
      const offenders: Array<{ file: string; line: number; text: string }> = [];
      for (const file of walk(SRC)) {
        if (file === CANONICAL_FILE) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          if (LITERAL_RE.test(line)) {
            offenders.push({ file: path.relative(SRC, file), line: idx + 1, text: line.trim() });
          }
        });
      }
      expect(offenders).toEqual([]);
    });
  });
});
