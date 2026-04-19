/**
 * =============================================================================
 * CI GUARD — no imports of the deleted server-routes / server-middleware
 * orphans (F-A-01)
 * =============================================================================
 *
 * The monolithic server.ts was never split into `server-routes.ts` +
 * `server-middleware.ts`; those two files lived as orphan copies that were
 * never imported anywhere. They were deleted in the P2 dead-code bundle.
 *
 * This guard fails if anyone reintroduces a reference to them from any
 * non-test source file under src/. Test files that only reference them as
 * descriptive strings (e.g. in comments) are intentionally excluded.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');
// This test file itself references the orphan names in describe/comments —
// exclude it from the scan to avoid a self-referential false positive.
const SELF = path.basename(__filename);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.name.endsWith('.ts') && entry.name !== SELF) {
      out.push(full);
    }
  }
  return out;
}

describe('No orphan server-routes / server-middleware references (F-A-01)', () => {
  // Catch actual module references: import / require / ESM-dynamic-import.
  // Descriptive prose in comments is intentionally out of scope so we don't
  // have to launder the historical record every time someone mentions the
  // cleanup in a docstring.
  const IMPORT_PATTERN =
    /(?:from\s+['"][^'"]*(?:server-routes|server-middleware)[^'"]*['"])|(?:require\(\s*['"][^'"]*(?:server-routes|server-middleware)[^'"]*['"]\s*\))|(?:import\(\s*['"][^'"]*(?:server-routes|server-middleware)[^'"]*['"]\s*\))/;
  const files = walkTs(SRC_ROOT);

  it('discovered source files under src/', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no file under src/ imports server-routes or server-middleware', () => {
    const offenders: Array<{ file: string; line: string }> = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (IMPORT_PATTERN.test(line)) {
          offenders.push({
            file: `${path.relative(SRC_ROOT, f)}:${i + 1}`,
            line: line.trim(),
          });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
