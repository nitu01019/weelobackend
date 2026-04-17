/**
 * =============================================================================
 * F-A-50 — CI Sentinel: OrderService class count
 * =============================================================================
 *
 * Counts `class OrderService` definitions in `src/modules/order/`. Today the
 * codebase has:
 *   1. `src/modules/order/order.service.ts`          — LIVE (wired via routes)
 *   2. `src/modules/order/order-delegates.service.ts` — delegate duplicate
 *
 * Total = 2 is the current accepted state during the F-A-50 soak window.
 *
 * Next step (follow-up PR, once parity holds in production): delete
 * `order-delegates.service.ts` and tighten this assertion to `=== 1`.
 *
 * Why this exists: prevents future work from re-forking `OrderService` into
 * a third or fourth class by accident (which is exactly how we got here).
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ORDER_MODULE_DIR = path.join(REPO_ROOT, 'src', 'modules', 'order');

function countOrderServiceClasses(): { total: number; files: string[] } {
  const entries = fs.readdirSync(ORDER_MODULE_DIR);
  const hits: string[] = [];
  // Match `class OrderService {` and `export class OrderService {`,
  // excluding TypeScript abstract/decorator variants (not currently in use).
  const pattern = /^(export\s+)?class\s+OrderService\b/m;

  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    // Ignore numbered duplicate backups created during splits (e.g. 'foo 2.ts')
    if (/\s\d+\.ts$/.test(entry)) continue;
    const abs = path.join(ORDER_MODULE_DIR, entry);
    const source = fs.readFileSync(abs, 'utf8');
    if (pattern.test(source)) hits.push(entry);
  }
  return { total: hits.length, files: hits };
}

describe('F-A-50: OrderService class count sentinel', () => {
  it('src/modules/order contains at most 2 OrderService class definitions (live + soak-delegate)', () => {
    const { total, files } = countOrderServiceClasses();
    // Informational: show which files matched when it fails.
    expect({ total, files }).toMatchObject({
      total: expect.any(Number),
    });
    expect(total).toBeLessThanOrEqual(2);
  });

  it('the live OrderService is defined in order.service.ts (not renamed or moved)', () => {
    const { files } = countOrderServiceClasses();
    expect(files).toContain('order.service.ts');
  });

  it('delegate duplicate, if present, lives in order-delegates.service.ts (no third fork)', () => {
    const { files } = countOrderServiceClasses();
    // Any file outside the allowlist is a regression.
    const allowed = new Set(['order.service.ts', 'order-delegates.service.ts']);
    for (const f of files) {
      expect(allowed.has(f)).toBe(true);
    }
  });
});
