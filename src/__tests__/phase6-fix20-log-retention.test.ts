/**
 * Phase 6 — Fix #20: DPDP Rule 8(3) §5(b) three-tier log retention
 *
 * Verifies:
 *  - cloudWatchConfig.logGroups exposes audit/application/access/error tiers
 *  - Each tier has { name, retentionDays } shape
 *  - audit retention defaults to 365 (DPDP Rule 8(3))
 *  - application + error retention defaults to 30 (DPDP §5(b) minimisation)
 *  - access retention defaults to 90
 *  - Back-compat shim cloudWatchConfig.logRetention still resolves
 *  - parseInt uses radix 10 (defends against empty-string env)
 *  - enforce-log-retention.sh exists, is executable, and ships orphan-guard
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Phase 6 Fix #20 — DPDP log retention three-tier split', () => {
    // Capture pre-existing env values so we can restore between tests.
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore env to the snapshot from beforeAll (no per-key leakage).
        process.env = { ...originalEnv };
        jest.resetModules();
    });

    describe('cloudWatchConfig.logGroups shape', () => {
        it('exposes audit, application, access, error tiers', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups).toEqual(
                    expect.objectContaining({
                        audit: expect.any(Object),
                        application: expect.any(Object),
                        access: expect.any(Object),
                        error: expect.any(Object),
                    })
                );
            });
        });

        it('each tier has { name, retentionDays } shape', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                for (const tier of ['audit', 'application', 'access', 'error']) {
                    expect(cloudWatchConfig.logGroups[tier]).toEqual(
                        expect.objectContaining({
                            name: expect.stringMatching(/^\/weelo\//),
                            retentionDays: expect.any(Number),
                        })
                    );
                }
            });
        });
    });

    describe('default retention values (DPDP-compliant)', () => {
        beforeEach(() => {
            delete process.env.LOG_RETENTION_AUDIT_DAYS;
            delete process.env.LOG_RETENTION_APP_DAYS;
            delete process.env.LOG_RETENTION_ACCESS_DAYS;
            delete process.env.LOG_RETENTION_DAYS;
        });

        it('audit defaults to 365 days (DPDP Rule 8(3))', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.audit.retentionDays).toBe(365);
                expect(cloudWatchConfig.logGroups.audit.name).toBe('/weelo/audit');
            });
        });

        it('application defaults to 30 days (DPDP §5(b) minimisation)', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.application.retentionDays).toBe(30);
                expect(cloudWatchConfig.logGroups.application.name).toBe('/weelo/application');
            });
        });

        it('access defaults to 90 days', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.access.retentionDays).toBe(90);
                expect(cloudWatchConfig.logGroups.access.name).toBe('/weelo/access');
            });
        });

        it('error defaults to 30 days (mirrors application tier)', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.error.retentionDays).toBe(30);
                expect(cloudWatchConfig.logGroups.error.name).toBe('/weelo/error');
            });
        });

        it('back-compat shim logRetention defaults to 30', () => {
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logRetention).toBe(30);
            });
        });
    });

    describe('env-var overrides', () => {
        it('LOG_RETENTION_AUDIT_DAYS overrides audit tier', () => {
            process.env.LOG_RETENTION_AUDIT_DAYS = '731';
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.audit.retentionDays).toBe(731);
            });
        });

        it('LOG_RETENTION_APP_DAYS overrides application AND error', () => {
            process.env.LOG_RETENTION_APP_DAYS = '60';
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.application.retentionDays).toBe(60);
                expect(cloudWatchConfig.logGroups.error.retentionDays).toBe(60);
            });
        });

        it('LOG_RETENTION_ACCESS_DAYS overrides access tier', () => {
            process.env.LOG_RETENTION_ACCESS_DAYS = '180';
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.access.retentionDays).toBe(180);
            });
        });

        it('empty-string env falls back to default (parseInt radix-10 guard)', () => {
            process.env.LOG_RETENTION_AUDIT_DAYS = '';
            process.env.LOG_RETENTION_APP_DAYS = '';
            process.env.LOG_RETENTION_ACCESS_DAYS = '';
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { cloudWatchConfig } = require('../config/aws.config');
                expect(cloudWatchConfig.logGroups.audit.retentionDays).toBe(365);
                expect(cloudWatchConfig.logGroups.application.retentionDays).toBe(30);
                expect(cloudWatchConfig.logGroups.access.retentionDays).toBe(90);
            });
        });
    });

    describe('parseInt radix-10 hardening', () => {
        it('source uses parseInt(..., 10) for all retention vars', () => {
            const source = fs.readFileSync(
                path.resolve(__dirname, '..', 'config', 'aws.config.ts'),
                'utf8'
            );
            // Every parseInt call inside cloudWatchConfig must specify radix 10.
            const matches = source.match(/parseInt\(process\.env\.LOG_RETENTION_[A-Z_]+\s*\|\|\s*'\d+'(?:,\s*10)?\)/g) ?? [];
            expect(matches.length).toBeGreaterThan(0);
            for (const m of matches) {
                expect(m).toContain(', 10');
            }
        });
    });

    describe('enforce-log-retention.sh script', () => {
        const scriptPath = path.resolve(
            __dirname,
            '..',
            '..',
            'scripts',
            'monitoring',
            'enforce-log-retention.sh'
        );

        it('script file exists', () => {
            expect(fs.existsSync(scriptPath)).toBe(true);
        });

        it('script is executable', () => {
            const stat = fs.statSync(scriptPath);
            // Owner-executable bit (0o100) — full 0o111 also covered.
            expect(stat.mode & 0o111).not.toBe(0);
        });

        it('script ships IAM self-check (sts get-caller-identity)', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toMatch(/aws sts get-caller-identity/);
        });

        it('script ships describe-log-groups IAM probe', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toMatch(/aws logs describe-log-groups/);
        });

        it('script ships orphan-guard (retentionInDays==`null`)', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toMatch(/retentionInDays==`null`/);
        });

        it('script applies retention to all four tiers', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toContain('"/weelo/audit"');
            expect(body).toContain('"/weelo/application"');
            expect(body).toContain('"/weelo/access"');
            expect(body).toContain('"/weelo/error"');
        });

        it('script validates retention values against AWS allowed-set', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toMatch(/allowed_days=\(1 3 5 7 14 30 60 90 120 150 180 365 400 545 731 1827 2192 2557 2922 3288 3653\)/);
        });

        it('script supports --dry-run flag', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toMatch(/--dry-run/);
            expect(body).toMatch(/DRY_RUN=1/);
        });

        it('script uses set -euo pipefail (fail-fast)', () => {
            const body = fs.readFileSync(scriptPath, 'utf8');
            expect(body).toMatch(/set -euo pipefail/);
        });
    });

    describe('.env.production.example three-tier vars', () => {
        const envPath = path.resolve(__dirname, '..', '..', '.env.production.example');

        it('exposes LOG_RETENTION_AUDIT_DAYS=365', () => {
            const body = fs.readFileSync(envPath, 'utf8');
            expect(body).toMatch(/^LOG_RETENTION_AUDIT_DAYS=365\b/m);
        });

        it('exposes LOG_RETENTION_APP_DAYS=30', () => {
            const body = fs.readFileSync(envPath, 'utf8');
            expect(body).toMatch(/^LOG_RETENTION_APP_DAYS=30\b/m);
        });

        it('exposes LOG_RETENTION_ACCESS_DAYS=90', () => {
            const body = fs.readFileSync(envPath, 'utf8');
            expect(body).toMatch(/^LOG_RETENTION_ACCESS_DAYS=90\b/m);
        });

        it('retains LOG_RETENTION_DAYS=30 as DEPRECATED back-compat shim', () => {
            const body = fs.readFileSync(envPath, 'utf8');
            expect(body).toMatch(/^LOG_RETENTION_DAYS=30\b/m);
            // The DEPRECATED comment must precede the shim line.
            expect(body).toMatch(/DEPRECATED[^\n]*\n+LOG_RETENTION_DAYS=30/);
        });
    });
});
