/**
 * =============================================================================
 * Phase 7 follow-up — Defect #9: H3_PARENT_RESOLUTION boot guard
 * =============================================================================
 *
 * If `H3_RESOLUTION=0`, `H3_PARENT_RESOLUTION = H3_RESOLUTION - 1 = -1`.
 * h3-js v4 `cellToParent(-1)` throws synchronously — but only when reached
 * deep in the dispatch hot path, far from the root cause. Fail loudly at
 * module load so misconfig is caught at boot, not at runtime.
 *
 * Industry: h3-js v4 API contract — valid resolutions are integers in [0, 15].
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const H3_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'h3-geo-index.service.ts');

describe('Phase 7 follow-up — Defect #9 H3_PARENT_RESOLUTION boot guard', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(H3_SERVICE_PATH, 'utf8');
  });

  it('throws at module load if H3_PARENT_RESOLUTION is below 0', () => {
    // Pattern: `if (H3_PARENT_RESOLUTION < 0 || H3_PARENT_RESOLUTION > 15) { throw new Error(...) }`
    expect(source).toMatch(
      /if\s*\(\s*H3_PARENT_RESOLUTION\s*<\s*0[\s\S]{0,80}H3_PARENT_RESOLUTION\s*>\s*15\s*\)\s*\{[\s\S]{0,300}throw\s+new\s+Error/,
    );
  });

  it('error message clearly identifies the offending value and the parent-resolution rule', () => {
    expect(source).toMatch(/BOOT GUARD:.*H3_PARENT_RESOLUTION/);
    expect(source).toMatch(/parent\s*=\s*H3_RESOLUTION\s*-\s*1/);
  });

  it('guard is placed AFTER H3_PARENT_RESOLUTION is computed', () => {
    const decl = source.indexOf('const H3_PARENT_RESOLUTION =');
    const guard = source.indexOf('BOOT GUARD: H3_PARENT_RESOLUTION');
    expect(decl).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(decl); // guard sits after the declaration
  });

  it('guard is placed BEFORE the existing FF_H3_DUAL_INDEX_READ warn (matches existing convention)', () => {
    const guard = source.indexOf('BOOT GUARD: H3_PARENT_RESOLUTION');
    const ffWarn = source.indexOf('BOOT GUARD: FF_H3_DUAL_INDEX_READ');
    expect(guard).toBeGreaterThan(-1);
    expect(ffWarn).toBeGreaterThan(-1);
    // resolution guard fires first because invalid resolution would crash before
    // FF semantics matter
    expect(guard).toBeLessThan(ffWarn);
  });

  // Behavioural — mirror the guard logic for unit-level isolation
  describe('behavioural mirror of guard semantics', () => {
    function mirror(parentResolution: number): void {
      if (parentResolution < 0 || parentResolution > 15) {
        throw new Error(
          `[H3Index] BOOT GUARD: H3_PARENT_RESOLUTION=${parentResolution} outside valid range [0,15].`,
        );
      }
    }

    it('rejects H3_PARENT_RESOLUTION = -1', () => {
      expect(() => mirror(-1)).toThrow(/BOOT GUARD.*outside valid range/);
    });

    it('rejects H3_PARENT_RESOLUTION = 16', () => {
      expect(() => mirror(16)).toThrow(/BOOT GUARD.*outside valid range/);
    });

    it('accepts the production default (H3_RESOLUTION=8 → parent=7)', () => {
      expect(() => mirror(7)).not.toThrow();
    });

    it('accepts the boundary values 0 and 15', () => {
      expect(() => mirror(0)).not.toThrow();
      expect(() => mirror(15)).not.toThrow();
    });
  });
});
