/**
 * =============================================================================
 * F-A-28 — Pricing constants SSOT (DEFAULT_AVG_SPEED_KMH)
 * =============================================================================
 *
 * Asserts that no production source file under src/ outside the canonical
 * location declares a literal `AVG_SPEED_KMH = <number>` or
 * `DEFAULT_AVG_SPEED_KMH = <number>` constant. The single source of truth
 * lives in `src/shared/utils/geospatial.utils.ts`.
 *
 * Test files under src/__tests__/** are excluded — they assert exact numeric
 * expectations and intentionally hardcode values for clarity.
 *
 * Distance/scoring services that pull from `process.env.HAVERSINE_AVG_SPEED_KMH`
 * are also excluded — those are env-driven knobs, not literal constants.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

/**
 * Recursively walk a directory and return all .ts files.
 * Skips: __tests__/, node_modules, .d.ts files.
 */
function walkTs(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walkTs(full, results);
    } else if (entry.isFile()) {
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      results.push(full);
    }
  }
  return results;
}

describe('F-A-28 — AVG_SPEED_KMH SSOT', () => {
  it('declares DEFAULT_AVG_SPEED_KMH exactly once in geospatial.utils.ts', () => {
    const allFiles = walkTs(SRC_ROOT);
    // Pattern: literal `AVG_SPEED_KMH = <number>` declaration (const/let/var
    // form) -- catches the legacy hardcoded `30` constants in driver services.
    const literalDecl = /\b(const|let|var)\s+(?:DEFAULT_)?AVG_SPEED_KMH\s*=\s*\d+(?:\.\d+)?\b/;

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of allFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (literalDecl.test(line)) {
          offenders.push({ file: path.relative(SRC_ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }

    // Allow the canonical export in geospatial.utils.ts (one declaration only).
    const canonicalPath = path.join('shared', 'utils', 'geospatial.utils.ts');
    const nonCanonical = offenders.filter((o) => o.file !== canonicalPath);

    expect(nonCanonical).toEqual([]);
    expect(offenders.length).toBeLessThanOrEqual(1);
  });

  it('exports DEFAULT_AVG_SPEED_KMH from geospatial.utils.ts', () => {
    // Lazy-require so the test file itself doesn't pin the export name at
    // load time before the canonical export exists (RED safety).
    const utils = require('../shared/utils/geospatial.utils');
    expect(typeof utils.DEFAULT_AVG_SPEED_KMH).toBe('number');
    expect(utils.DEFAULT_AVG_SPEED_KMH).toBeGreaterThan(0);
  });
});
