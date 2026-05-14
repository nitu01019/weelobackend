import * as fs from 'fs';
import * as path from 'path';
import { PROGRESSIVE_RADIUS_STEPS } from '../modules/order/progressive-radius-matcher';

describe('Fix #15 — RadiusStep contract + anti-regression (no cellToChildren in getCandidatesNewRing)', () => {
  describe('PROGRESSIVE_RADIUS_STEPS literal contract (Step 2 Assertions A/B/C)', () => {
    it('PROGRESSIVE_RADIUS_STEPS has exactly 6 entries', () => {
      expect(PROGRESSIVE_RADIUS_STEPS).toHaveLength(6);
    });

    it('every entry carries h3QueryResolution and h3FallbackRingK as numbers (Assertion A)', () => {
      for (let i = 0; i < PROGRESSIVE_RADIUS_STEPS.length; i++) {
        const step = PROGRESSIVE_RADIUS_STEPS[i] as any;
        expect(typeof step.h3QueryResolution).toBe('number');
        expect(typeof step.h3FallbackRingK).toBe('number');
      }
    });

    it('entries match index-30-validated.md L4119-4128 / L4242-4249 exactly (Assertion C)', () => {
      const expected = [
        { radiusKm: 5,   windowMs: 10_000, h3RingK: 8,   h3QueryResolution: 8, h3FallbackRingK: 8 },
        { radiusKm: 10,  windowMs: 10_000, h3RingK: 15,  h3QueryResolution: 8, h3FallbackRingK: 15 },
        { radiusKm: 15,  windowMs: 15_000, h3RingK: 22,  h3QueryResolution: 8, h3FallbackRingK: 22 },
        { radiusKm: 30,  windowMs: 15_000, h3RingK: 17,  h3QueryResolution: 7, h3FallbackRingK: 44 },
        { radiusKm: 60,  windowMs: 15_000, h3RingK: 33,  h3QueryResolution: 7, h3FallbackRingK: 88 },
        { radiusKm: 100, windowMs: 15_000, h3RingK: 57,  h3QueryResolution: 7, h3FallbackRingK: 150 },
      ];
      for (let i = 0; i < expected.length; i++) {
        const step = PROGRESSIVE_RADIUS_STEPS[i] as any;
        expect(step.radiusKm).toBe(expected[i].radiusKm);
        expect(step.windowMs).toBe(expected[i].windowMs);
        expect(step.h3RingK).toBe(expected[i].h3RingK);
        expect(step.h3QueryResolution).toBe(expected[i].h3QueryResolution);
        expect(step.h3FallbackRingK).toBe(expected[i].h3FallbackRingK);
      }
    });
  });

  describe('Anti-regression: getCandidatesNewRing must NOT contain cellToChildren (Assertion D)', () => {
    it('getCandidatesNewRing body region in h3-geo-index.service.ts contains no cellToChildren call', () => {
      const filePath = path.resolve(__dirname, '../shared/services/h3-geo-index.service.ts');
      const src = fs.readFileSync(filePath, 'utf8');
      const fnStart = src.indexOf('getCandidatesNewRing');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSlice = src.slice(fnStart, fnStart + 4000);
      expect(fnSlice).not.toContain('cellToChildren');
    });
  });
});
