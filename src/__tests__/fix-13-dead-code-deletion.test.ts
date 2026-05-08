/**
 * =============================================================================
 * FIX #13 — Dead acceptBroadcast deletion (Kismet's patch)
 * =============================================================================
 *
 * Source-contract test:
 *   - The dead `acceptBroadcast` method on BroadcastService class is removed.
 *   - File size shrunk from ~1300 LOC to ~786 LOC.
 *   - Live exports still resolve:
 *       * `broadcastService` singleton
 *       * `getActiveBroadcasts`, `getBroadcastById`, `declineBroadcast`,
 *         `getBroadcastHistory`, `createBroadcast`, `emitBroadcastExpired`,
 *         `emitTrucksRemainingUpdate`, `checkAndExpireBroadcasts`
 *   - The canonical `acceptBroadcast` lives in
 *     src/modules/broadcast/broadcast-accept.service.ts (untouched).
 *   - broadcast.routes.ts still binds to the live module: imports both
 *     `broadcastService` (for query/decline) and `acceptBroadcast` from
 *     broadcast-accept.service.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const mock_13_broadcastServicePath = path.resolve(
  __dirname,
  '../modules/broadcast/broadcast.service.ts'
);
const mock_13_acceptServicePath = path.resolve(
  __dirname,
  '../modules/broadcast/broadcast-accept.service.ts'
);
const mock_13_routesPath = path.resolve(
  __dirname,
  '../modules/broadcast/broadcast.routes.ts'
);

describe('Fix #13 — dead acceptBroadcast on BroadcastService class is deleted', () => {
  let mock_13_serviceSrc: string;
  let mock_13_acceptSrc: string;
  let mock_13_routesSrc: string;

  beforeAll(() => {
    mock_13_serviceSrc = fs.readFileSync(mock_13_broadcastServicePath, 'utf8');
    mock_13_acceptSrc = fs.readFileSync(mock_13_acceptServicePath, 'utf8');
    mock_13_routesSrc = fs.readFileSync(mock_13_routesPath, 'utf8');
  });

  it('broadcast.service.ts no longer contains an `async acceptBroadcast(` method', () => {
    expect(mock_13_serviceSrc).not.toMatch(/async\s+acceptBroadcast\s*\(/);
  });

  it('broadcast.service.ts is significantly smaller (< 900 LOC)', () => {
    const lineCount = mock_13_serviceSrc.split('\n').length;
    expect(lineCount).toBeLessThan(900);
  });

  it('broadcast.service.ts still exports the broadcastService singleton', () => {
    expect(mock_13_serviceSrc).toMatch(
      /export\s+const\s+broadcastService\s*=\s*new\s+BroadcastService\s*\(\s*\)\s*;/
    );
  });

  it('broadcast.service.ts still declares class BroadcastService', () => {
    expect(mock_13_serviceSrc).toMatch(/class\s+BroadcastService\s*\{/);
  });

  it.each([
    'getActiveBroadcasts',
    'getBroadcastById',
    'declineBroadcast',
    'getBroadcastHistory',
    'createBroadcast',
    'emitBroadcastExpired',
    'emitTrucksRemainingUpdate',
    'checkAndExpireBroadcasts',
  ])('broadcast.service.ts still defines live method %s(', (name) => {
    const re = new RegExp(`async\\s+${name}\\s*\\(`);
    expect(mock_13_serviceSrc).toMatch(re);
  });

  it('canonical acceptBroadcast lives in broadcast-accept.service.ts', () => {
    expect(mock_13_acceptSrc).toMatch(
      /export\s+async\s+function\s+acceptBroadcast\s*\(/
    );
  });

  it('broadcast.routes.ts imports acceptBroadcast from broadcast-accept.service (NOT broadcast.service)', () => {
    // Routes import from accept service
    expect(mock_13_routesSrc).toMatch(
      /import\s+\{\s*acceptBroadcast[^}]*\}\s+from\s+['"]\.\/broadcast-accept\.service['"]/
    );
    // Routes do NOT import acceptBroadcast from broadcast.service.ts
    const importsFromBroadcastService = mock_13_routesSrc.match(
      /import\s+\{[^}]*\}\s+from\s+['"]\.\/broadcast\.service['"]/
    );
    if (importsFromBroadcastService) {
      expect(importsFromBroadcastService[0]).not.toMatch(/\bacceptBroadcast\b/);
    }
  });

  it('broadcast.routes.ts still imports the broadcastService singleton (live path intact)', () => {
    expect(mock_13_routesSrc).toMatch(
      /import\s+\{[^}]*broadcastService[^}]*\}\s+from\s+['"]\.\/broadcast\.service['"]/
    );
  });
});

export {};
