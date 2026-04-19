/**
 * =============================================================================
 * F-C-75 — env.example completeness contract
 * =============================================================================
 *
 * Asserts the CI lint script `scripts/verify-env-example.ts` passes (exit 0).
 * Covers the silent-drift scenario where a new `process.env.FOO_BAR` is
 * declared in env.validation.ts but `.env.example` never gets the matching
 * KEY=<default> line.
 *
 * Notes:
 *  - Script lives in `scripts/` (outside jest's `rootDir: src/`), so we
 *    invoke it via the ts-node CLI entry-point rather than `require()`-ing
 *    it. This mirrors how the script is invoked in CI via `npm run lint:env`.
 *  - Synthetic drift is produced by writing a tampered .env.example to a
 *    tmp dir and invoking the script against it with an override env var
 *    understood by the script itself (no side effects on the real repo).
 * =============================================================================
 */

export {};

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TS_NODE_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'ts-node');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'verify-env-example.ts');

/**
 * Runs the lint script, returns { code, stdout, stderr }.
 */
function runLint(opts?: {
  envExamplePathOverride?: string;
}): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  if (opts?.envExamplePathOverride) {
    env.ENV_EXAMPLE_PATH_OVERRIDE = opts.envExamplePathOverride;
  }
  try {
    const stdout = execFileSync(TS_NODE_BIN, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: e.status ?? 1,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
    };
  }
}

describe('F-C-75 verify-env-example contract', () => {
  it('CI entry-point exits 0 for the current repo state', () => {
    const { code, stdout } = runLint();
    expect(code).toBe(0);
    expect(stdout).toMatch(/\[verify-env-example\] OK/);
  });

  it('CI entry-point FAILS (non-zero exit) when .env.example drops a declared key', () => {
    // Regression guard — the linter must actually fail when drift is introduced.
    const original = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf-8');
    const tampered = original.replace(
      /^FLEX_HOLD_EXTENSION_SECONDS=30\s*$/m,
      '# intentionally omitted for drift test'
    );
    expect(tampered).not.toBe(original); // confirm we actually altered something

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weelo-envlint-'));
    const tmpExample = path.join(tmpDir, '.env.example');
    fs.writeFileSync(tmpExample, tampered, 'utf-8');

    try {
      const { code, stderr } = runLint({ envExamplePathOverride: tmpExample });
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/FLEX_HOLD_EXTENSION_SECONDS/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
