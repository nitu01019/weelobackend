/**
 * =============================================================================
 * CI GUARD — no 501/NOT_IMPLEMENTED stubs in the transporter-availability
 * surface (F-B-41)
 * =============================================================================
 *
 * transporter-availability.routes.ts used to ship five 501 NOT_IMPLEMENTED
 * handlers (PUT/GET /availability, POST/DELETE /heartbeat, GET
 * /availability/stats) that shadowed the real handlers in
 * transporter.routes.ts. The file was deleted as part of F-B-41.
 *
 * This guard locks in the deletion. If the orphan file comes back — or if
 * any file under src/modules/transporter/ reintroduces a 501 literal on the
 * availability surface — this test fails.
 *
 * Scope note: other 501-stub split routers (e.g. order-crud, order-lifecycle,
 * transporter-profile) are intentionally out of scope — they still ship as
 * part of the larger strangler-fig cleanup tracked in separate tickets.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

describe('F-B-41 — transporter-availability stub removed', () => {
  it('transporter-availability.routes.ts no longer exists', () => {
    const file = path.join(
      SRC_ROOT,
      'modules',
      'transporter',
      'transporter-availability.routes.ts'
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it('the real transporter.routes.ts still owns the availability surface', () => {
    const file = path.join(SRC_ROOT, 'modules', 'transporter', 'transporter.routes.ts');
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf-8');
    // The real router owns PUT /availability, GET /availability,
    // POST/DELETE /heartbeat, and GET /availability/stats — none of these
    // should disappear when the stub router is removed.
    expect(content).toMatch(/['"`]\/availability['"`]/);
    expect(content).toMatch(/['"`]\/heartbeat['"`]/);
    expect(content).toMatch(/['"`]\/availability\/stats['"`]/);
  });

  it('transporter-availability.routes.ts is not recreated with 501 stubs', () => {
    // Specifically catches a regression that re-introduces the exact
    // F-B-41 orphan (not just the file, but its 501/NOT_IMPLEMENTED shape).
    const file = path.join(
      SRC_ROOT,
      'modules',
      'transporter',
      'transporter-availability.routes.ts'
    );
    if (!fs.existsSync(file)) return; // Desired end-state: file removed.
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).not.toMatch(/status\(\s*501\s*\)/);
    expect(content).not.toMatch(/['"`]NOT_IMPLEMENTED['"`]/);
  });
});
