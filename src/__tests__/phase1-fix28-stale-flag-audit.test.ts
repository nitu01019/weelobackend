import * as fs from 'fs';
import * as path from 'path';

describe('Fix #28 — stale-flag audit infrastructure exists', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('scripts/audit-stale-flags.ts exists', () => {
    expect(fs.existsSync(path.join(repoRoot, 'scripts/audit-stale-flags.ts'))).toBe(true);
  });
  it('GHA cron workflow exists', () => {
    expect(fs.existsSync(path.join(repoRoot, '.github/workflows/audit-stale-flags.yml'))).toBe(true);
  });
  it('FlagMetadata interface present in feature-flags.ts', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/shared/config/feature-flags.ts'), 'utf8');
    expect(src).toMatch(/interface\s+FlagMetadata\b/);
    expect(src).toMatch(/sunsetAt:/);
    expect(src).toMatch(/'rollout'\s*\|\s*'stable'\s*\|\s*'pending-retirement'/);
  });
  it('FlagDefinition has optional meta field', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/shared/config/feature-flags.ts'), 'utf8');
    expect(src).toMatch(/meta\?:\s*FlagMetadata/);
  });
  it('callsiteCount takes both envName and flagKey (Pandora R6-C)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/audit-stale-flags.ts'), 'utf8');
    // Signature: function callsiteCount(envName: string, flagKey: string): number
    expect(src).toMatch(/function\s+callsiteCount\s*\(\s*envName\s*:\s*string\s*,\s*flagKey\s*:\s*string/);
    // Implementation must search file contents for BOTH envName AND `FLAGS.${flagKey}`.
    // We previously used `grep -rln -e "..."` (shell-out); the implementation is now a
    // pure-Node directory walk to clear Semgrep's child_process taint warning. Either
    // implementation satisfies the audit contract — assert behavior, not mechanism.
    expect(src).toMatch(/content\.includes\(\s*envName\s*\)/);
    expect(src).toMatch(/FLAGS\.\$\{flagKey\}/);
  });
  it('audit script does NOT shell out (Semgrep child_process clearance)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/audit-stale-flags.ts'), 'utf8');
    // Anti-regression: prevent a future change from re-introducing execSync / spawnSync
    // shell-outs in this script. Webhook delivery now uses native fetch.
    expect(src).not.toMatch(/from\s+['"]child_process['"]/);
    expect(src).not.toMatch(/\bexecSync\s*\(/);
    expect(src).not.toMatch(/\bspawnSync\s*\(/);
  });
  it('GHA workflow has if: always() artifact guard', () => {
    const yml = fs.readFileSync(path.join(repoRoot, '.github/workflows/audit-stale-flags.yml'), 'utf8');
    expect(yml).toMatch(/if:\s*always\(\)/);
    expect(yml).toMatch(/upload-artifact/);
  });
});
