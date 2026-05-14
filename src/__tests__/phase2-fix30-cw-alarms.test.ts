import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const dockerfilePath = path.join(repoRoot, 'Dockerfile');
const alarmsScriptPath = path.join(repoRoot, 'scripts/monitoring/setup-alarms.sh');

describe('Phase 2 Fix #30 — infra (Dockerfile aws-cli + setup-alarms.sh)', () => {
  describe('Dockerfile (main, NOT Dockerfile.production)', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    it('installs aws-cli in BOTH production and development stages', () => {
      const awsCliMatches = dockerfile.match(/apk add --no-cache[^\n]*aws-cli/g) || [];
      expect(awsCliMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves existing openssl installs across all stages', () => {
      const opensslMatches = dockerfile.match(/apk add --no-cache[^\n]*openssl/g) || [];
      expect(opensslMatches.length).toBeGreaterThanOrEqual(3);
    });

    it('has aws-cli installed in the production stage', () => {
      const prodStart = dockerfile.indexOf('FROM node:20-alpine AS production');
      const prodEnd = dockerfile.indexOf('FROM node:20-alpine AS development');
      expect(prodStart).toBeGreaterThan(-1);
      expect(prodEnd).toBeGreaterThan(prodStart);
      const prodStage = dockerfile.slice(prodStart, prodEnd);
      expect(prodStage).toMatch(/apk add --no-cache[^\n]*aws-cli/);
    });

    it('has aws-cli installed in the development stage', () => {
      const devStart = dockerfile.indexOf('FROM node:20-alpine AS development');
      expect(devStart).toBeGreaterThan(-1);
      const devStage = dockerfile.slice(devStart);
      expect(devStage).toMatch(/apk add --no-cache[^\n]*aws-cli/);
    });
  });

  describe('scripts/monitoring/setup-alarms.sh', () => {
    const alarmsScript = fs.readFileSync(alarmsScriptPath, 'utf8');

    it('defines weelo-migration-lock-not-available alarm', () => {
      expect(alarmsScript).toContain('--alarm-name weelo-migration-lock-not-available');
    });

    it('defines weelo-migration-failed alarm', () => {
      expect(alarmsScript).toContain('--alarm-name weelo-migration-failed');
    });

    it('uses ${ALARM_SNS_TOPIC_ARN} (canonical) for alarm-actions', () => {
      const matches = alarmsScript.match(/--alarm-actions "\$\{ALARM_SNS_TOPIC_ARN\}"/g) || [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT reference PAGERDUTY_SNS_ARN (Magnus R6-B rename)', () => {
      expect(alarmsScript).not.toMatch(/PAGERDUTY_SNS_ARN/);
    });

    it('both migration alarms set treat-missing-data notBreaching', () => {
      const migrationBlockStart = alarmsScript.indexOf('weelo-migration-lock-not-available');
      const migrationSection = alarmsScript.slice(migrationBlockStart);
      const notBreachingMatches = migrationSection.match(/--treat-missing-data notBreaching/g) || [];
      expect(notBreachingMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('both migration alarms use namespace Weelo/Backend', () => {
      const migrationBlockStart = alarmsScript.indexOf('weelo-migration-lock-not-available');
      const migrationSection = alarmsScript.slice(migrationBlockStart);
      const nsMatches = migrationSection.match(/--namespace Weelo\/Backend/g) || [];
      expect(nsMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('weelo-migration-failed alarm filters dimension result=failed', () => {
      const failedStart = alarmsScript.indexOf('--alarm-name weelo-migration-failed');
      expect(failedStart).toBeGreaterThan(-1);
      const failedBlock = alarmsScript.slice(failedStart, failedStart + 1000);
      expect(failedBlock).toContain('--dimensions Name=result,Value=failed');
    });

    it('weelo-migration-lock-not-available alarm has threshold 3 / period 900 / GTE comparison', () => {
      const lockStart = alarmsScript.indexOf('--alarm-name weelo-migration-lock-not-available');
      expect(lockStart).toBeGreaterThan(-1);
      const lockBlock = alarmsScript.slice(lockStart, lockStart + 1000);
      expect(lockBlock).toContain('--metric-name migration_lock_not_available_total');
      expect(lockBlock).toMatch(/--statistic Sum/);
      expect(lockBlock).toMatch(/--period 900/);
      expect(lockBlock).toMatch(/--threshold 3/);
      expect(lockBlock).toContain('--comparison-operator GreaterThanOrEqualToThreshold');
    });

    it('weelo-migration-failed alarm has threshold 1 / period 900 / GTE comparison', () => {
      const failedStart = alarmsScript.indexOf('--alarm-name weelo-migration-failed');
      const failedBlock = alarmsScript.slice(failedStart, failedStart + 1000);
      expect(failedBlock).toContain('--metric-name migration_status');
      expect(failedBlock).toMatch(/--statistic Sum/);
      expect(failedBlock).toMatch(/--period 900/);
      expect(failedBlock).toMatch(/--threshold 1/);
      expect(failedBlock).toContain('--comparison-operator GreaterThanOrEqualToThreshold');
    });

    it('keeps ALARM_SNS_TOPIC_ARN required-assert in prelude', () => {
      expect(alarmsScript).toMatch(/:\s*"\$\{ALARM_SNS_TOPIC_ARN:\?[^"]+\}"/);
    });

    it('both migration alarms target region ap-south-1', () => {
      const migrationBlockStart = alarmsScript.indexOf('weelo-migration-lock-not-available');
      const migrationSection = alarmsScript.slice(migrationBlockStart);
      const regionMatches = migrationSection.match(/--region ap-south-1/g) || [];
      expect(regionMatches.length).toBeGreaterThanOrEqual(2);
    });
  });
});
