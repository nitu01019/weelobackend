/**
 * =============================================================================
 * F-A-79 — CI LINT: hold-state-machine.ts exclusive-use invariant
 * =============================================================================
 *
 * This test enforces the architectural rule set by F-A-79:
 *
 *   "Any write to `TruckHoldLedger.phase` must flow through
 *    `hold-state-machine.ts`\'s `guardedConfirmFlexToConfirmed` helper
 *    (or its sibling helpers added in later waves)."
 *
 * Baseline (2026-04-18, F-A-79 merge):
 *   The helper is exported but not yet wired. Today the confirm path is
 *   a raw `tx.truckHoldLedger.update({...phase: HoldPhase.CONFIRMED...})`
 *   inside `truck-hold.service.ts` (2 sites), `flex-hold.service.ts`
 *   (1 site), and `confirmed-hold.service.ts` (1 site). These are the
 *   legitimate FLEX->CONFIRMED writes — three production files total.
 *
 * Policy:
 *   The count of raw-phase writers MUST NOT GROW beyond the baseline.
 *   When F-A-80 saga extraction (Wave 2) lands, each call site migrates
 *   to `guardedConfirmFlexToConfirmed` and the baseline shrinks. If this
 *   test fails with "count INCREASED", the PR author must either
 *     (a) route through the helper (preferred), OR
 *     (b) explain the new exception and bump the baseline in this file.
 *
 * Test-file writes are ignored — only production source under
 * `src/modules/` is counted.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULES_ROOT = path.join(REPO_ROOT, 'src', 'modules');
const HELPER_REL = 'src/modules/truck-hold/hold-state-machine.ts';

const BASELINE_RAW_PHASE_WRITER_FILES = 3;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (
      stat.isFile() &&
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      // Skip macOS iCloud/sync duplicate artefacts (e.g. "file 2.ts", "file 3.ts")
      !/ \d+\.ts$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function readSource(abs: string): string {
  return fs.readFileSync(abs, 'utf8');
}

function hasRawPhaseWrite(src: string): boolean {
  const normalized = src.replace(/\s+/g, ' ');
  const re = /truckHoldLedger\.update(?:Many)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const window = normalized.slice(m.index, m.index + 1500);
    if (/\bphase\s*:\s*HoldPhase\./.test(window)) {
      return true;
    }
  }
  return false;
}

describe('F-A-79 hold-state-machine.ts exclusive-use lint', () => {
  it('raw TruckHoldLedger phase writes are bounded by the baseline (no growth)', () => {
    const files = walk(MODULES_ROOT);
    const offenders = files.filter((abs) => {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (rel === HELPER_REL) return false;
      return hasRawPhaseWrite(readSource(abs));
    });

    const offenderNames = offenders.map((abs) =>
      path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
    );

    expect({
      count: offenders.length,
      files: offenderNames.sort(),
    }).toEqual({
      count: BASELINE_RAW_PHASE_WRITER_FILES,
      files: [
        'src/modules/truck-hold/confirmed-hold.service.ts',
        'src/modules/truck-hold/flex-hold.service.ts',
        'src/modules/truck-hold/truck-hold.service.ts',
      ],
    });
  });

  it('hold-state-machine.ts exists and is the canonical owner of phase-transition writes', () => {
    const helperAbs = path.join(REPO_ROOT, HELPER_REL);
    expect(fs.existsSync(helperAbs)).toBe(true);
    const src = readSource(helperAbs);
    expect(src).toMatch(/guardedConfirmFlexToConfirmed/);
    expect(src).toMatch(/assertHoldPhaseTransition/);
    expect(src).toMatch(/HoldTransitionError/);
    const normalized = src.replace(/\s+/g, ' ');
    expect(normalized).toMatch(
      /tx\.truckHoldLedger\.updateMany\(\s*\{\s*where:\s*\{[^}]*phase:\s*HoldPhase\.FLEX[^}]*status:\s*[\'"]active[\'"]/,
    );
  });
});
