/**
 * =============================================================================
 * DEAD-CODE ORPHAN GUARD (F-A-01 + F-A-29 + F-B-41)
 * =============================================================================
 *
 * CI guard — these files were removed as part of the P2 dead-code bundle:
 *
 *   - src/server-routes.ts                               (F-A-01, 178 LOC)
 *   - src/server-middleware.ts                           (F-A-01, 123 LOC)
 *   - src/shared/services/google-directions.service.ts   (F-A-29, 257 LOC)
 *   - src/modules/transporter/transporter-availability.routes.ts (F-B-41, 501 stub)
 *
 * If anyone reintroduces one of these, the file-existence check here fails
 * and the intent (delete, do not resurrect) is surfaced in review.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

const DELETED_FILES: Array<{ file: string; issue: string; reason: string }> = [
  {
    file: 'server-routes.ts',
    issue: 'F-A-01',
    reason: 'Orphan — never imported anywhere in src/',
  },
  {
    file: 'server-middleware.ts',
    issue: 'F-A-01',
    reason: 'Orphan — never imported anywhere in src/',
  },
  {
    file: 'shared/services/google-directions.service.ts',
    issue: 'F-A-29',
    reason: 'Zero callers (googleDirectionsService never referenced)',
  },
  {
    file: 'modules/transporter/transporter-availability.routes.ts',
    issue: 'F-B-41',
    reason: '501 NOT_IMPLEMENTED stub router — routes live in transporter.routes.ts',
  },
];

describe('Dead-code orphan guard', () => {
  test.each(DELETED_FILES)(
    'deleted: src/$file ($issue) — $reason',
    ({ file }) => {
      const fullPath = path.join(SRC_ROOT, file);
      expect(fs.existsSync(fullPath)).toBe(false);
    }
  );
});
