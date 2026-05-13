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
    expect(src).toMatch(/function\s+callsiteCount\s*\(\s*envName\s*:\s*string\s*,\s*flagKey\s*:\s*string/);
    expect(src).toMatch(/grep\s+-rln\s+-e\s+["'][^"']*\$\{envName\}/);
    expect(src).toMatch(/-e\s+["']FLAGS\\+\.\$\{flagKey\}/);
  });
  it('GHA workflow has if: always() artifact guard', () => {
    const yml = fs.readFileSync(path.join(repoRoot, '.github/workflows/audit-stale-flags.yml'), 'utf8');
    expect(yml).toMatch(/if:\s*always\(\)/);
    expect(yml).toMatch(/upload-artifact/);
  });
});
