import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('Fix #21 — Sentry/OTEL stub files deleted', () => {
  it('src/instrument.ts does not exist', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../instrument.ts'))).toBe(false);
  });
  it('src/instrumentation.ts does not exist', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../instrumentation.ts'))).toBe(false);
  });
  it('tsconfig.json exclude no longer references deleted files', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../tsconfig.json'), 'utf8'));
    expect(tsconfig.exclude).not.toContain('src/instrument.ts');
    expect(tsconfig.exclude).not.toContain('src/instrumentation.ts');
  });
  it('.env.production.example no longer contains SENTRY_DSN', () => {
    const env = fs.readFileSync(path.resolve(__dirname, '../../.env.production.example'), 'utf8');
    expect(env).not.toMatch(/^SENTRY_DSN=/m);
  });
  it('no production .ts file imports the deleted modules', () => {
    const out = execSync(
      "grep -rE \"from ['\\\"](\\.+/)*instrument(ation)?['\\\"]|require\\(['\\\"](\\.+/)*instrument(ation)?['\\\"]\\)\" src/ --include='*.ts' || true",
      { encoding: 'utf8' }
    ).trim();
    expect(out).toBe('');
  });
});
