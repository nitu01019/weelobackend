/**
 * =============================================================================
 * F-A-38 — /route-multi Zod validation + weighted IP budget (RED test)
 * =============================================================================
 *
 * Expected behavior:
 *   - Enforces Zod schema on body.points (2..25 entries, lat/lng bounds,
 *     label max 128).
 *   - When FF_ROUTE_MULTI_WEIGHTED_BUDGET=true, deducts (points.length - 1)
 *     units from the per-IP route-multi budget rather than flat 1 unit.
 *   - Maintains fail-open + 429 DAILY_LIMIT_EXCEEDED response shape.
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../modules/routing/route-multi.schema.ts',
);
const ROUTES_PATH = path.resolve(
  __dirname,
  '../modules/routing/geocoding.routes.ts',
);
const FLAGS_PATH = path.resolve(
  __dirname,
  '../shared/config/feature-flags.ts',
);

function readSource(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

describe('F-A-38: /route-multi Zod + weighted budget', () => {
  // -------------------------------------------------------------------------
  // 1. Schema file exists and exports routeMultiSchema
  // -------------------------------------------------------------------------
  describe('route-multi.schema.ts', () => {
    it('exists at src/modules/routing/route-multi.schema.ts', () => {
      expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    });

    it('exports routeMultiSchema', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      expect(routeMultiSchema).toBeDefined();
      expect(typeof routeMultiSchema.parse).toBe('function');
    });

    it('rejects bodies with <2 points', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const r = routeMultiSchema.safeParse({ points: [{ lat: 1, lng: 1 }] });
      expect(r.success).toBe(false);
    });

    it('rejects bodies with >25 points', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const bigPoints = Array.from({ length: 26 }, (_, i) => ({ lat: i * 0.1, lng: i * 0.1 }));
      const r = routeMultiSchema.safeParse({ points: bigPoints });
      expect(r.success).toBe(false);
    });

    it('rejects lat > 90', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const r = routeMultiSchema.safeParse({
        points: [
          { lat: 95, lng: 0 },
          { lat: 0, lng: 0 },
        ],
      });
      expect(r.success).toBe(false);
    });

    it('rejects lng > 180', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const r = routeMultiSchema.safeParse({
        points: [
          { lat: 0, lng: 190 },
          { lat: 0, lng: 0 },
        ],
      });
      expect(r.success).toBe(false);
    });

    it('rejects label > 128 chars', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const longLabel = 'a'.repeat(129);
      const r = routeMultiSchema.safeParse({
        points: [
          { lat: 1, lng: 1, label: longLabel },
          { lat: 2, lng: 2 },
        ],
      });
      expect(r.success).toBe(false);
    });

    it('accepts 2 valid points', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const r = routeMultiSchema.safeParse({
        points: [
          { lat: 28.6, lng: 77.2, label: 'Pickup' },
          { lat: 19.0, lng: 72.8 },
        ],
      });
      expect(r.success).toBe(true);
    });

    it('accepts 20 valid points', () => {
      const { routeMultiSchema } = require('../modules/routing/route-multi.schema');
      const pts = Array.from({ length: 20 }, (_, i) => ({ lat: 28 + i * 0.01, lng: 77 + i * 0.01 }));
      const r = routeMultiSchema.safeParse({ points: pts });
      expect(r.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Routes wiring
  // -------------------------------------------------------------------------
  describe('geocoding.routes.ts /route-multi wiring', () => {
    let routesSrc: string;
    beforeAll(() => { routesSrc = readSource(ROUTES_PATH); });

    it('imports routeMultiSchema', () => {
      expect(routesSrc).toMatch(
        /import\s*\{[^}]*routeMultiSchema[^}]*\}\s*from\s*['"][^'"]*route-multi\.schema['"]/,
      );
    });

    it('uses routeMultiSchema inside the /route-multi handler', () => {
      const routeIdx = routesSrc.indexOf("'/route-multi'");
      expect(routeIdx).toBeGreaterThan(-1);
      const block = routesSrc.substring(routeIdx, routeIdx + 3000);
      expect(block).toMatch(/routeMultiSchema\.(parse|safeParse)/);
    });

    it('references FF_ROUTE_MULTI_WEIGHTED_BUDGET flag', () => {
      expect(routesSrc).toMatch(/ROUTE_MULTI_WEIGHTED_BUDGET/);
    });

    it('computes weighted cost = points.length - 1 under the weighted-budget path', () => {
      const routeIdx = routesSrc.indexOf("'/route-multi'");
      const block = routesSrc.substring(routeIdx, routeIdx + 3000);
      // Assert the inversion-safe arithmetic is present somewhere in the block.
      expect(block).toMatch(/points\.length\s*-\s*1/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Feature flag registration
  // -------------------------------------------------------------------------
  describe('feature-flags registry', () => {
    let flagsSrc: string;
    beforeAll(() => { flagsSrc = readSource(FLAGS_PATH); });

    it('registers FF_ROUTE_MULTI_WEIGHTED_BUDGET as release (default OFF)', () => {
      expect(flagsSrc).toContain('FF_ROUTE_MULTI_WEIGHTED_BUDGET');
      const idx = flagsSrc.indexOf('FF_ROUTE_MULTI_WEIGHTED_BUDGET');
      const block = flagsSrc.substring(idx, idx + 400);
      expect(block).toMatch(/category:\s*['"]release['"]/);
    });
  });
});
