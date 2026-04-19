/**
 * =============================================================================
 * F-A-40 — Truck-route avoid=highways|tolls inversion fix (RED test)
 * =============================================================================
 *
 * In India, heavy trucks prefer NH/expressways and FASTag tolls. Passing
 * `avoid=highways|tolls` for truckMode forces the route engine to avoid the
 * very roads trucks are meant to use → unsafe detours through small streets.
 *
 * Expected:
 *   - Flag FF_TRUCK_ROUTE_AVOID_HIGHWAYS registered, default OFF.
 *   - With flag OFF (default), truck-mode calls do NOT include avoid=highways|tolls.
 *   - With flag ON (legacy), truck-mode calls still append avoid=highways|tolls.
 *   - Non-truck calls never include avoid parameter.
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

const SERVICE_PATH = path.resolve(
  __dirname,
  '../shared/services/google-maps.service.ts',
);
const FLAGS_PATH = path.resolve(
  __dirname,
  '../shared/config/feature-flags.ts',
);

function readSource(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

describe('F-A-40: Truck-route highway-avoid inversion fix', () => {
  // -------------------------------------------------------------------------
  // 1. Feature flag registered as release, default OFF
  // -------------------------------------------------------------------------
  describe('feature-flags registry', () => {
    let flagsSrc: string;
    beforeAll(() => { flagsSrc = readSource(FLAGS_PATH); });

    it('registers FF_TRUCK_ROUTE_AVOID_HIGHWAYS', () => {
      expect(flagsSrc).toContain('FF_TRUCK_ROUTE_AVOID_HIGHWAYS');
    });

    it('is classified as release (default OFF = safe fix)', () => {
      const idx = flagsSrc.indexOf('FF_TRUCK_ROUTE_AVOID_HIGHWAYS');
      const block = flagsSrc.substring(idx, idx + 400);
      expect(block).toMatch(/category:\s*['"]release['"]/);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Source wiring: avoid block gated by flag
  // -------------------------------------------------------------------------
  describe('google-maps.service.ts source wiring', () => {
    let serviceSrc: string;
    beforeAll(() => { serviceSrc = readSource(SERVICE_PATH); });

    it('avoid=highways|tolls is behind a feature flag check', () => {
      // The literal 'avoid', 'highways|tolls' append should no longer be a
      // bare `if (truckMode)` — it must be gated on FF_TRUCK_ROUTE_AVOID_HIGHWAYS.
      const avoidIdx = serviceSrc.indexOf("'avoid', 'highways|tolls'");
      expect(avoidIdx).toBeGreaterThan(-1);

      // Look backwards ~400 chars for the enclosing condition.
      const preContext = serviceSrc.substring(Math.max(0, avoidIdx - 400), avoidIdx);
      expect(preContext).toMatch(
        /FF_TRUCK_ROUTE_AVOID_HIGHWAYS|TRUCK_ROUTE_AVOID_HIGHWAYS/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Runtime: default OFF means URL has NO avoid parameter
  // -------------------------------------------------------------------------
  describe('runtime: FF_TRUCK_ROUTE_AVOID_HIGHWAYS=false (safe default)', () => {
    const originalFlag = process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS;
    const originalApiKey = process.env.GOOGLE_MAPS_API_KEY;

    beforeEach(() => {
      jest.resetModules();
      process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS = 'false';
      // Ensure API is "available" so the URL build path runs.
      process.env.GOOGLE_MAPS_API_KEY = 'test-key-for-routing-test';
    });
    afterEach(() => {
      if (originalFlag === undefined) delete process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS;
      else process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS = originalFlag;
      if (originalApiKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
      else process.env.GOOGLE_MAPS_API_KEY = originalApiKey;
    });

    it('truckMode=true calls to Directions API do NOT include avoid=highways', async () => {
      const calls: string[] = [];
      const originalFetch = (global as any).fetch;
      (global as any).fetch = async (url: string, _opts?: any) => {
        calls.push(String(url));
        return {
          json: async () => ({ status: 'OK', routes: [] }), // no route → calculateRoute returns null
        } as any;
      };

      try {
        const { googleMapsService } = require('../shared/services/google-maps.service');
        await googleMapsService.calculateRoute(
          [
            { lat: 28.6, lng: 77.2 },
            { lat: 19.0, lng: 72.8 },
          ],
          true, // truckMode
        );
      } catch { /* ignore — we only care about URL composition */ }
      finally {
        (global as any).fetch = originalFetch;
      }

      // With flag OFF (default), NO call should include avoid=highways
      const hasAvoid = calls.some((u) => /avoid=highways/.test(u) || /avoid=highways%7Ctolls/.test(u));
      expect(hasAvoid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Runtime: legacy flag ON keeps the avoid param
  // -------------------------------------------------------------------------
  describe('runtime: FF_TRUCK_ROUTE_AVOID_HIGHWAYS=true (legacy)', () => {
    const originalFlag = process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS;
    const originalApiKey = process.env.GOOGLE_MAPS_API_KEY;

    beforeEach(() => {
      jest.resetModules();
      process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS = 'true';
      process.env.GOOGLE_MAPS_API_KEY = 'test-key-for-routing-test';
    });
    afterEach(() => {
      if (originalFlag === undefined) delete process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS;
      else process.env.FF_TRUCK_ROUTE_AVOID_HIGHWAYS = originalFlag;
      if (originalApiKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
      else process.env.GOOGLE_MAPS_API_KEY = originalApiKey;
    });

    it('truckMode=true with legacy flag ON appends avoid=highways|tolls', async () => {
      const calls: string[] = [];
      const originalFetch = (global as any).fetch;
      (global as any).fetch = async (url: string, _opts?: any) => {
        calls.push(String(url));
        return {
          json: async () => ({ status: 'OK', routes: [] }),
        } as any;
      };

      try {
        const { googleMapsService } = require('../shared/services/google-maps.service');
        await googleMapsService.calculateRoute(
          [
            { lat: 28.6, lng: 77.2 },
            { lat: 19.0, lng: 72.8 },
          ],
          true,
        );
      } catch { /* ignore */ }
      finally {
        (global as any).fetch = originalFetch;
      }

      const hasAvoid = calls.some((u) => /avoid=highways/.test(u) || /avoid=highways%7Ctolls/.test(u));
      expect(hasAvoid).toBe(true);
    });
  });
});
