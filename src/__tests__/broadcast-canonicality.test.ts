/**
 * =============================================================================
 * BROADCAST CANONICALITY — AST guard for F-B-77 (Strangler Fig)
 * =============================================================================
 *
 * Per WEELO-CRITICAL-SOLUTION.md §F-B-77, there must be exactly ONE canonical
 * implementation of broadcastToTransporters (at
 * `src/modules/order/order-broadcast.service.ts`). All other declarations must
 * be thin wrappers that delegate to the canonical via the delegates bridge
 * (`src/modules/order/order-delegates-bridge.service.ts`).
 *
 * This test scans the source tree for declarations and fails CI if any
 * declaration outside the canonical module is NOT a thin-wrap.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '..');
const CANONICAL_FILE = path.resolve(SRC_DIR, 'modules/order/order-broadcast.service.ts');
const BRIDGE_FILE = path.resolve(SRC_DIR, 'modules/order/order-delegates-bridge.service.ts');

const DECLARATION_PATTERNS = [
  /function\s+broadcastToTransporters\s*\(/,
  /broadcastToTransporters\s*[:=]\s*async\s*\(/,
  /broadcastToTransporters\s*[:=]\s*\(/,
  /async\s+broadcastToTransporters\s*\(/,
];

const CALL_CANONICAL_VIA_BRIDGE = /order-delegates-bridge(\.service)?['"]/;
const CALL_CANONICAL_DIRECT = /broadcastToTransportersFn|from\s+['"][^'"]*order-broadcast(\.service)?['"]/;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'dist') continue;
      walkTsFiles(full, out);
    } else if (e.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function findDeclarations(content: string): boolean {
  return DECLARATION_PATTERNS.some(p => p.test(content));
}

describe('F-B-77 broadcast canonicality', () => {
  const allFiles = walkTsFiles(SRC_DIR);

  it('has canonical broadcast file present', () => {
    expect(fs.existsSync(CANONICAL_FILE)).toBe(true);
    const content = fs.readFileSync(CANONICAL_FILE, 'utf8');
    expect(/export\s+async\s+function\s+broadcastToTransporters\s*\(/.test(content)).toBe(true);
  });

  it('has delegates bridge re-export present', () => {
    expect(fs.existsSync(BRIDGE_FILE)).toBe(true);
    const content = fs.readFileSync(BRIDGE_FILE, 'utf8');
    expect(/broadcastToTransportersFn/.test(content)).toBe(true);
    expect(/export\s+async\s+function\s+broadcastToTransporters\s*\(/.test(content)).toBe(true);
  });

  it('all broadcastToTransporters declarations outside canonical are thin-wraps to bridge/canonical', () => {
    const offenders: string[] = [];

    for (const file of allFiles) {
      const normalized = path.resolve(file);
      if (normalized === CANONICAL_FILE) continue;
      if (normalized === BRIDGE_FILE) continue;

      const content = fs.readFileSync(file, 'utf8');
      if (!findDeclarations(content)) continue;

      const delegatesToCanonical =
        CALL_CANONICAL_VIA_BRIDGE.test(content) || CALL_CANONICAL_DIRECT.test(content);

      if (!delegatesToCanonical) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `F-B-77 violation: the following files declare broadcastToTransporters without delegating to the canonical source:\n  - ${offenders.join('\n  - ')}\n\nEach fork must thin-wrap to order-delegates-bridge.service.ts or order-broadcast.service.ts. See WEELO-CRITICAL-SOLUTION.md §F-B-77.`
      );
    }

    expect(offenders).toEqual([]);
  });

  it('known forks retain thin-wrap delegation', () => {
    const knownForks = [
      path.resolve(SRC_DIR, 'modules/booking/order.service.ts'),
      path.resolve(SRC_DIR, 'modules/booking/legacy-order-create.service.ts'),
    ];

    for (const fork of knownForks) {
      expect(fs.existsSync(fork)).toBe(true);
      const content = fs.readFileSync(fork, 'utf8');
      const hasDecl = findDeclarations(content);
      const delegates =
        CALL_CANONICAL_VIA_BRIDGE.test(content) || CALL_CANONICAL_DIRECT.test(content);
      expect({ fork, hasDecl, delegates }).toEqual({ fork, hasDecl: true, delegates: true });
    }
  });
});
