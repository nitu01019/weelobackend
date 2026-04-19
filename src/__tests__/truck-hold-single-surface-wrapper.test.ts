/**
 * =============================================================================
 * F-A-76 THIN-WRAP MARKERS — Strangler Fig intermediate CI guard
 * =============================================================================
 *
 * F-A-76 converted the 5 split hold files into thin-wrapper stubs marked for
 * Phase 4 deletion after a 1-week soak. This suite guards the intermediate
 * state:
 *
 *   1. Each split file carries the `FIX F-A-76` deprecation marker so
 *      readers see the Strangler Fig intent before editing.
 *   2. Each split file explicitly names the monolith (`truckHoldService` /
 *      truck-hold.service.ts) as the canonical surface.
 *   3. The monolith still carries the production implementation — grep-
 *      verified on `truckHoldService.holdTrucks` and
 *      `truckHoldService.confirmHoldWithAssignments`.
 *   4. No PRODUCTION source file (non-test, non-split) imports from a split
 *      file. Tests are permitted because fs.readFileSync + jest.mock
 *      assertions still need these files to exist until Phase 4.
 *
 * Source-text assertions (no runtime) so this suite is fast and dependency-
 * free. When Phase 4 deletes the split files, delete this file as well.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const MODULE_DIR = path.resolve(__dirname, '../modules/truck-hold');
const SRC_DIR = path.resolve(__dirname, '..');

const SPLIT_FILES = [
  'truck-hold-create.service.ts',
  'truck-hold-confirm.service.ts',
  'truck-hold-release.service.ts',
  'truck-hold-cleanup.service.ts',
  'truck-hold-crud.routes.ts',
];

describe('F-A-76 thin-wrap markers (Strangler Fig intermediate)', () => {
  describe.each(SPLIT_FILES)('%s', (filename) => {
    const filePath = path.join(MODULE_DIR, filename);
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(filePath, 'utf-8');
    });

    test('file exists and is readable', () => {
      expect(fs.existsSync(filePath)).toBe(true);
      expect(source.length).toBeGreaterThan(0);
    });

    test('carries FIX F-A-76 deprecation marker in header', () => {
      expect(source).toContain('FIX F-A-76');
      expect(source).toContain('thin-wrap marker');
      expect(source).toContain('Strangler Fig');
    });

    test('names Phase 4 as the deletion target', () => {
      expect(source).toContain('Phase 4');
    });

    test('points new callers at the monolith', () => {
      expect(source).toContain('truckHoldService');
    });
  });
});

describe('F-A-76 monolith canonical surface', () => {
  const monolithPath = path.join(MODULE_DIR, 'truck-hold.service.ts');
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(monolithPath, 'utf-8');
  });

  test('truck-hold.service.ts exports truckHoldService singleton', () => {
    expect(source).toMatch(/export const truckHoldService\s*=\s*new TruckHoldService\(\)/);
  });

  test('monolith owns holdTrucks runtime method', () => {
    expect(source).toMatch(/async holdTrucks\(/);
  });

  test('monolith owns confirmHoldWithAssignments runtime method', () => {
    expect(source).toMatch(/async confirmHoldWithAssignments\(/);
  });

  test('monolith owns releaseHold runtime method', () => {
    expect(source).toMatch(/async releaseHold\(/);
  });

  test('monolith owns closeActiveHoldsForOrder runtime method', () => {
    expect(source).toMatch(/async closeActiveHoldsForOrder\(/);
  });

  test('monolith owns clearHoldCacheEntries runtime method', () => {
    expect(source).toMatch(/async clearHoldCacheEntries\(/);
  });

  test('monolith owns startCleanupJob / stopCleanupJob methods', () => {
    expect(source).toMatch(/startCleanupJob\(\)/);
    expect(source).toMatch(/stopCleanupJob\(\)/);
  });
});

describe('F-A-76 no new production importers', () => {
  const productionDirs = [
    'modules',
    'shared',
    'core',
  ];

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
        out.push(...walk(full));
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const splitFileBasenames = SPLIT_FILES.map(f => f.replace(/\.ts$/, ''));
  const allProductionFiles = productionDirs.flatMap(d => walk(path.join(SRC_DIR, d)));

  test('no production file imports from a split hold module', () => {
    const offenders: string[] = [];
    for (const file of allProductionFiles) {
      if (file.includes(path.sep + 'truck-hold' + path.sep)) {
        continue;
      }
      const txt = fs.readFileSync(file, 'utf-8');
      for (const base of splitFileBasenames) {
        const pattern = new RegExp(`from\\s+['"\`][^'"\`]*${base.replace(/\./g, '\\.')}['"\`]`);
        const reqPattern = new RegExp(`require\\(\\s*['"\`][^'"\`]*${base.replace(/\./g, '\\.')}['"\`]`);
        if (pattern.test(txt) || reqPattern.test(txt)) {
          offenders.push(`${path.relative(SRC_DIR, file)} -> ${base}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
