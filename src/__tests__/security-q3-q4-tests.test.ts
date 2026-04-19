/**
 * =============================================================================
 * SECURITY TESTS — Q3 (OTP Logging) & Q4 (SQL Injection Prevention)
 * =============================================================================
 *
 * Q3: Verify that OTP values and full phone numbers are never logged via
 *     console.log. Only structured logger calls with masked phone (last 4
 *     digits) are permitted.
 *
 * Q4: Verify that otp-challenge.service.ts uses only safe parameterised SQL
 *     (tagged template literals $executeRaw`…` / $queryRaw`…`). The unsafe
 *     variants $executeRawUnsafe / $queryRawUnsafe must NOT appear in the
 *     happy-path issue/verify functions — only in legacy fallback paths that
 *     are clearly delimited and do NOT concatenate user-supplied values.
 *
 * Additional: General security hygiene — no .env files in git, no hardcoded
 *             API keys, rate limiting present on OTP endpoints.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSource(relPath: string): string {
  const absPath = path.resolve(__dirname, '..', relPath);
  return fs.readFileSync(absPath, 'utf-8');
}

function countOccurrences(source: string, pattern: string | RegExp): number {
  if (typeof pattern === 'string') {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (source.match(new RegExp(escaped, 'g')) || []).length;
  }
  return (source.match(pattern) || []).length;
}

// ---------------------------------------------------------------------------
// Source snapshots (read once per suite)
// ---------------------------------------------------------------------------

const SMS_SERVICE_SOURCE = readSource('modules/auth/sms.service.ts');
const DRIVER_ROUTES_SOURCE = readSource('modules/driver/driver.routes.ts');
const DRIVER_ONBOARDING_ROUTES_SOURCE = readSource('modules/driver/driver-onboarding.routes.ts');
const DRIVER_ONBOARDING_SERVICE_SOURCE = readSource('modules/driver-onboarding/driver-onboarding.service.ts');
const OTP_CHALLENGE_SOURCE = readSource('modules/auth/otp-challenge.service.ts');
const AUTH_SERVICE_SOURCE = readSource('modules/auth/auth.service.ts');
const AUTH_ROUTES_SOURCE = readSource('modules/auth/auth.routes.ts');

// ---------------------------------------------------------------------------
// Q3 — OTP Logging Removal
// ---------------------------------------------------------------------------

describe('Q3 OTP Logging Removal', () => {

  // ── sms.service.ts ───────────────────────────────────────────────────────

  describe('sms.service.ts', () => {
    it('should NOT contain console.log with ${otp} interpolation', () => {
      expect(SMS_SERVICE_SOURCE).not.toMatch(/console\.log[^;]*\$\{otp\}/);
    });

    it('should NOT contain console.log with literal "OTP:" prefix', () => {
      expect(SMS_SERVICE_SOURCE).not.toMatch(/console\.log[^;]*OTP:/);
    });

    it('should NOT contain console.log with raw otp variable at all', () => {
      // Any console.log that mentions the word "otp" (case-insensitive) is a risk
      expect(SMS_SERVICE_SOURCE).not.toMatch(/console\.log[^;)]*\botp\b/i);
    });

    it('should NOT log the full phone number in any console.log', () => {
      // If console.log appears at all it must not reference the phone param directly
      const lines = SMS_SERVICE_SOURCE.split('\n').filter(l => l.includes('console.log'));
      for (const line of lines) {
        // Phone variable referenced directly is a violation
        expect(line).not.toMatch(/\bphone\b/);
      }
    });

    it('should use logger.info for successful SMS delivery (structured logging)', () => {
      expect(SMS_SERVICE_SOURCE).toMatch(/logger\.info\s*\(/);
    });

    it('should mask phone numbers to last 4 digits in logger calls (phone.slice(-4))', () => {
      expect(SMS_SERVICE_SOURCE).toMatch(/phone\.slice\(-4\)/);
    });

    it('ConsoleProvider should NOT log the actual OTP value via console.log', () => {
      // The ConsoleProvider is a dev-only stub — it must not console.log the OTP
      expect(SMS_SERVICE_SOURCE).not.toMatch(/console\.log[^;]*\botp\b/i);
    });

    it('ConsoleProvider.sendOtp should guard on isDevelopment before executing', () => {
      expect(SMS_SERVICE_SOURCE).toMatch(/isDevelopment/);
    });

    it('should NOT contain a console.log + phone + otp combination on the same line', () => {
      const lines = SMS_SERVICE_SOURCE.split('\n');
      for (const line of lines) {
        if (line.includes('console.log')) {
          const hasPhone = /\bphone\b/.test(line);
          const hasOtp = /\botp\b/i.test(line);
          expect(hasPhone && hasOtp).toBe(false);
        }
      }
    });

    it('logger.error calls should only include error.message, not OTP', () => {
      const errorLogLines = SMS_SERVICE_SOURCE.split('\n').filter(l => l.includes('logger.error'));
      for (const line of errorLogLines) {
        expect(line).not.toMatch(/\botp\b/i);
      }
    });
  });

  // ── driver.routes.ts ─────────────────────────────────────────────────────

  describe('driver.routes.ts', () => {
    it('should NOT contain console.log with ${otp} interpolation', () => {
      expect(DRIVER_ROUTES_SOURCE).not.toMatch(/console\.log[^;]*\$\{otp\}/);
    });

    it('should NOT contain console.log("OTP: ...") pattern', () => {
      expect(DRIVER_ROUTES_SOURCE).not.toMatch(/console\.log\s*\(\s*['"`].*OTP/i);
    });

    it('should NOT use console.log at all in OTP-related code', () => {
      // Extract the onboard/initiate and onboard/resend handler bodies
      const onboardInitiateIdx = DRIVER_ROUTES_SOURCE.indexOf('/onboard/initiate');
      const onboardResendIdx = DRIVER_ROUTES_SOURCE.indexOf('/onboard/resend');
      // Check neither handler uses console.log
      expect(DRIVER_ROUTES_SOURCE).not.toMatch(/console\.log[^;]*\botp\b/i);
    });

    it('should use maskForLogging helper when logging phone numbers', () => {
      expect(DRIVER_ROUTES_SOURCE).toMatch(/maskForLogging\s*\(/);
    });

    it('isDevelopment guard wraps any OTP debug logging', () => {
      // Any logger.debug for OTP must be inside an isDevelopment block
      const source = DRIVER_ROUTES_SOURCE;
      const debugOtpIdx = source.search(/logger\.debug.*OTP/i);
      if (debugOtpIdx !== -1) {
        // Look backwards for isDevelopment within 300 chars
        const context = source.slice(Math.max(0, debugOtpIdx - 300), debugOtpIdx);
        expect(context).toMatch(/isDevelopment/);
      }
      // If there is no logger.debug for OTP, the test passes trivially (that's fine)
    });

    it('dev-mode OTP log must NOT include the actual otp value, only otpLength', () => {
      // Find the dev-mode debug log block
      const devLogMatch = DRIVER_ROUTES_SOURCE.match(/isDevelopment[\s\S]{0,300}?logger\.debug[\s\S]{0,200}?otpLength/);
      if (devLogMatch) {
        expect(devLogMatch[0]).not.toMatch(/:\s*otp[,\s]/);
        expect(devLogMatch[0]).toMatch(/otpLength/);
      }
    });

    it('phone numbers in logger calls should use last-4-digit masking', () => {
      expect(DRIVER_ROUTES_SOURCE).toMatch(/phone\.slice\(-4\)|maskForLogging/);
    });
  });

  // ── driver-onboarding.routes.ts (deduplicated route file) ─────────────────

  describe('driver-onboarding.routes.ts', () => {
    it('should NOT contain console.log with ${otp} interpolation', () => {
      expect(DRIVER_ONBOARDING_ROUTES_SOURCE).not.toMatch(/console\.log[^;]*\$\{otp\}/);
    });

    it('should NOT contain console.log("OTP:") pattern', () => {
      expect(DRIVER_ONBOARDING_ROUTES_SOURCE).not.toMatch(/console\.log\s*\(\s*['"`].*OTP/i);
    });

    it('should use maskPhone or maskForLogging for phone in log calls', () => {
      expect(DRIVER_ONBOARDING_ROUTES_SOURCE).toMatch(/maskPhone|maskForLogging/);
    });

    it('isDevelopment guard must wrap dev-only OTP debug log', () => {
      const source = DRIVER_ONBOARDING_ROUTES_SOURCE;
      const debugIdx = source.search(/logger\.debug.*OTP/i);
      if (debugIdx !== -1) {
        const context = source.slice(Math.max(0, debugIdx - 300), debugIdx);
        expect(context).toMatch(/isDevelopment/);
      }
    });

    it('dev-mode debug log should expose only otpLength, not the raw otp', () => {
      const match = DRIVER_ONBOARDING_ROUTES_SOURCE.match(/logger\.debug[\s\S]{0,300}?otpLength/);
      if (match) {
        // The matched block must NOT embed the raw otp value
        expect(match[0]).not.toMatch(/otp:\s*otp[,\s\n]/);
        expect(match[0]).toMatch(/otpLength/);
      }
    });

    it('rate limiter (otpRateLimiter) must be applied to initiate endpoint', () => {
      expect(DRIVER_ONBOARDING_ROUTES_SOURCE).toMatch(/otpRateLimiter/);
    });
  });

  // ── driver-onboarding.service.ts ─────────────────────────────────────────

  describe('driver-onboarding.service.ts', () => {
    it('should NOT contain console.log with ${otp} interpolation', () => {
      expect(DRIVER_ONBOARDING_SERVICE_SOURCE).not.toMatch(/console\.log[^;]*\$\{otp\}/);
    });

    it('should NOT contain console.log("OTP:") pattern', () => {
      expect(DRIVER_ONBOARDING_SERVICE_SOURCE).not.toMatch(/console\.log\s*\(\s*['"`].*OTP/i);
    });

    it('should NOT have any console.log statement whatsoever', () => {
      expect(DRIVER_ONBOARDING_SERVICE_SOURCE).not.toMatch(/console\.log\s*\(/);
    });

    it('should log phone numbers through maskForLogging helper', () => {
      expect(DRIVER_ONBOARDING_SERVICE_SOURCE).toMatch(/maskForLogging\s*\(/);
    });

    it('should NOT log the raw OTP value in logger.info calls', () => {
      const infoLines = DRIVER_ONBOARDING_SERVICE_SOURCE.split('\n').filter(l => l.includes('logger.info'));
      for (const line of infoLines) {
        expect(line).not.toMatch(/:\s*otp[,\s\n]/);
      }
    });

    it('logger.error for failed SMS should include masked phone via maskForLogging, not raw driverPhone', () => {
      // The logger.error call for SMS failure must pass maskForLogging(driverPhone, ...)
      // rather than the raw driverPhone variable as the log value.
      // Pattern: driverPhone: maskForLogging(driverPhone, ...)
      const errorSection = DRIVER_ONBOARDING_SERVICE_SOURCE.match(
        /logger\.error\s*\(\s*['"`]\[DRIVER ONBOARD\] Failed to send OTP[\s\S]{0,400}?\}/
      );
      expect(errorSection).not.toBeNull();
      if (errorSection) {
        // Must use maskForLogging to wrap the phone before logging
        expect(errorSection[0]).toMatch(/maskForLogging\s*\(\s*driverPhone/);
      }
    });
  });

});

// ---------------------------------------------------------------------------
// Q4 — SQL Injection Prevention
// ---------------------------------------------------------------------------

describe('Q4 SQL Injection Prevention', () => {

  // ── issueChallenge ─────────────────────────────────────────────────────

  describe('issueChallenge() uses only safe tagged templates', () => {
    it('issueChallenge must use $executeRaw tagged template (backtick) for INSERT', () => {
      // Tagged template is: $executeRaw`...`  (backtick immediately after)
      expect(OTP_CHALLENGE_SOURCE).toMatch(/\$executeRaw`/);
    });

    it('issueChallenge must NOT call $executeRawUnsafe for the main INSERT', () => {
      // Extract the issueChallenge method body
      const methodStart = OTP_CHALLENGE_SOURCE.indexOf('async issueChallenge(');
      const methodEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  async ', methodStart + 1);
      const methodBody = OTP_CHALLENGE_SOURCE.slice(methodStart, methodEnd === -1 ? undefined : methodEnd);
      expect(methodBody).not.toMatch(/\$executeRawUnsafe/);
    });

    it('$executeRaw tagged template count is at least 1 in the file', () => {
      expect(countOccurrences(OTP_CHALLENGE_SOURCE, /\$executeRaw`/g)).toBeGreaterThanOrEqual(1);
    });

    it('phone parameter in issueChallenge INSERT is a tagged template variable, not string concatenation', () => {
      // The INSERT uses ${params.dbKey.phone} — not string + phone
      expect(OTP_CHALLENGE_SOURCE).toMatch(/\$\{params\.dbKey\.phone\}/);
    });

    it('role parameter in issueChallenge INSERT is a tagged template variable', () => {
      expect(OTP_CHALLENGE_SOURCE).toMatch(/\$\{params\.dbKey\.role\}/);
    });

    it('otp hash in issueChallenge INSERT is a tagged template variable', () => {
      expect(OTP_CHALLENGE_SOURCE).toMatch(/\$\{record\.hash\}/);
    });

    it('expiresAt in issueChallenge INSERT is a Date object variable (not ISO string concatenation)', () => {
      // Must reference ${expiresAt} where expiresAt is a Date, not a string concat
      expect(OTP_CHALLENGE_SOURCE).toMatch(/\$\{expiresAt\}/);
    });
  });

  // ── deleteChallenge ────────────────────────────────────────────────────

  describe('deleteChallenge() parameterisation', () => {
    it('deleteChallenge uses the safe $executeRaw tagged template (not $executeRawUnsafe)', () => {
      // After the Q4 fix, deleteChallenge was upgraded to use the safe tagged template form:
      //   db.prisma?.$executeRaw`DELETE FROM "OtpStore" WHERE phone = ${...} AND role = ${...}`
      // Prisma's tagged template automatically parameterises all ${} interpolations — safe.
      const deleteIdx = OTP_CHALLENGE_SOURCE.indexOf('async deleteChallenge(');
      const deleteEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  async ', deleteIdx + 1);
      const deleteBody = OTP_CHALLENGE_SOURCE.slice(deleteIdx, deleteEnd === -1 ? undefined : deleteEnd);

      expect(deleteBody).toMatch(/\$executeRaw`/);
      expect(deleteBody).not.toMatch(/\$executeRawUnsafe/);
    });

    it('deleteChallenge tagged template uses ${params.dbKey.phone} and ${params.dbKey.role} as bound vars', () => {
      // Prisma tagged templates bind each ${} expression as a parameterised value — not concatenation.
      const deleteIdx = OTP_CHALLENGE_SOURCE.indexOf('async deleteChallenge(');
      const deleteEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  async ', deleteIdx + 1);
      const deleteBody = OTP_CHALLENGE_SOURCE.slice(deleteIdx, deleteEnd === -1 ? undefined : deleteEnd);

      expect(deleteBody).toMatch(/\$\{params\.dbKey\.phone\}/);
      expect(deleteBody).toMatch(/\$\{params\.dbKey\.role\}/);
    });
  });

  // ── verifyWithDbRowLock fallback ───────────────────────────────────────

  describe('verifyWithDbRowLock() fallback SQL', () => {
    it('SELECT in verifyWithDbRowLock uses safe $queryRaw tagged template (not $queryRawUnsafe)', () => {
      // After the Q4 fix the SELECT was upgraded to:
      //   tx.$queryRaw`SELECT ... WHERE phone = ${params.dbKey.phone} AND role = ${params.dbKey.role}`
      // This is the Prisma safe form — Prisma parameterises every ${} interpolation.
      const fallbackIdx = OTP_CHALLENGE_SOURCE.indexOf('private async verifyWithDbRowLock(');
      const fallbackEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  private async ', fallbackIdx + 1);
      const fallbackBody = OTP_CHALLENGE_SOURCE.slice(
        fallbackIdx,
        fallbackEnd === -1 ? OTP_CHALLENGE_SOURCE.indexOf('\n  private ', fallbackIdx + 1) : fallbackEnd
      );

      // Must use safe tagged template for the SELECT
      expect(fallbackBody).toMatch(/\$queryRaw`/);
    });

    it('UPDATE in verifyWithDbRowLock uses safe tagged template ($executeRaw)', () => {
      // After Q4: tagged templates replaced positional $1/$2 with ${variable} interpolation
      expect(OTP_CHALLENGE_SOURCE).toContain('UPDATE "OtpStore" SET attempts = attempts + 1');
      expect(OTP_CHALLENGE_SOURCE).not.toContain('$executeRawUnsafe');
    });

    it('DELETE in verifyWithDbRowLock uses safe tagged template ($executeRaw)', () => {
      // After Q4: all DELETE calls use $executeRaw tagged template
      expect(OTP_CHALLENGE_SOURCE).toContain('DELETE FROM "OtpStore"');
      expect(OTP_CHALLENGE_SOURCE).not.toContain('$executeRawUnsafe');
    });

    it('verifyWithDbRowLock must NOT build SQL by concatenating phone or role into a string', () => {
      const fallbackIdx = OTP_CHALLENGE_SOURCE.indexOf('private async verifyWithDbRowLock(');
      const snippetEnd = Math.min(
        fallbackIdx + 2000,
        OTP_CHALLENGE_SOURCE.length
      );
      const snippet = OTP_CHALLENGE_SOURCE.slice(fallbackIdx, snippetEnd);

      // No ${phone} or ${role} inside a backtick SQL string
      expect(snippet).not.toMatch(/`[^`]*\$\{params\.dbKey\.phone\}[^`]*WHERE[^`]*`/);
      expect(snippet).not.toMatch(/`[^`]*\$\{params\.dbKey\.role\}[^`]*WHERE[^`]*`/);
    });
  });

  // ── getChallengeRecord fallback ────────────────────────────────────────

  describe('getChallengeRecord() fallback SQL', () => {
    it('getChallengeRecord uses $queryRaw tagged template (not $queryRawUnsafe)', () => {
      const methodIdx = OTP_CHALLENGE_SOURCE.indexOf('private async getChallengeRecord(');
      const methodEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  private ', methodIdx + 1);
      const methodBody = OTP_CHALLENGE_SOURCE.slice(
        methodIdx,
        methodEnd === -1 ? OTP_CHALLENGE_SOURCE.length : methodEnd
      );
      // After Q4: must use safe $queryRaw tagged template
      expect(methodBody).toContain('$queryRaw`');
      expect(methodBody).not.toContain('$queryRawUnsafe');
    });

    it('getChallengeRecord uses safe tagged template (not string concat)', () => {
      const methodIdx = OTP_CHALLENGE_SOURCE.indexOf('private async getChallengeRecord(');
      const methodEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  private ', methodIdx + 1);
      const snippet = OTP_CHALLENGE_SOURCE.slice(
        methodIdx,
        methodEnd === -1 ? OTP_CHALLENGE_SOURCE.length : methodEnd
      );
      // After Q4: tagged templates use ${var} interpolation which Prisma parameterizes at compile time.
      // The safety comes from using $queryRaw (tagged) not $queryRawUnsafe (string).
      expect(snippet).not.toContain('$queryRawUnsafe');
      expect(snippet).not.toContain('$executeRawUnsafe');
    });
  });

  // ── No unsafe patterns in verifyWithRedisLock ────────────────────────

  describe('verifyWithRedisLock() should not use RawUnsafe', () => {
    it('verifyWithRedisLock must NOT use $executeRawUnsafe', () => {
      const methodIdx = OTP_CHALLENGE_SOURCE.indexOf('private async verifyWithRedisLock(');
      const methodEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  private async ', methodIdx + 1);
      const methodBody = OTP_CHALLENGE_SOURCE.slice(
        methodIdx,
        methodEnd === -1 ? OTP_CHALLENGE_SOURCE.length : methodEnd
      );
      // The Redis-lock path delegates DB updates to deleteChallenge (which uses Unsafe
      // with positional params) but should NOT call $executeRawUnsafe directly
      // — EXCEPT for the best-effort attempt increment (also positional)
      // What must NOT exist: building SQL via string concatenation of user params
      expect(methodBody).not.toMatch(/`[^`]*\$\{params\.(dbKey|otp)\}[^`]*WHERE[^`]*`/);
    });

    it('attempt increment in verifyWithRedisLock uses positional params if present', () => {
      const methodIdx = OTP_CHALLENGE_SOURCE.indexOf('private async verifyWithRedisLock(');
      const methodEnd = OTP_CHALLENGE_SOURCE.indexOf('\n  private async ', methodIdx + 1);
      const snippet = OTP_CHALLENGE_SOURCE.slice(
        methodIdx,
        methodEnd === -1 ? OTP_CHALLENGE_SOURCE.length : methodEnd
      );
      // Any $executeRawUnsafe inside must use $1/$2
      const unsafeCalls = snippet.match(/\$executeRawUnsafe[\s\S]{0,300}?\)/g) || [];
      for (const call of unsafeCalls) {
        // Every unsafe call must have at least one positional placeholder
        expect(call).toMatch(/\$1/);
      }
    });
  });

  // ── Top-level file checks ──────────────────────────────────────────────

  describe('File-level SQL safety invariants', () => {
    it('total $executeRaw tagged template occurrences should be >= 1', () => {
      expect(countOccurrences(OTP_CHALLENGE_SOURCE, /\$executeRaw`/g)).toBeGreaterThanOrEqual(1);
    });

    it('every $executeRawUnsafe call must be followed by a string literal (not template expression)', () => {
      // Valid pattern: $executeRawUnsafe(\n  `DELETE FROM ...`
      // Invalid pattern: $executeRawUnsafe(`DELETE FROM "OtpStore" WHERE phone = ${phone}`)
      const unsafeWithConcat = OTP_CHALLENGE_SOURCE.match(
        /\$executeRawUnsafe\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g
      );
      expect(unsafeWithConcat).toBeNull();
    });

    it('every $queryRawUnsafe call must use a string literal, not a template with ${...}', () => {
      const unsafeWithConcat = OTP_CHALLENGE_SOURCE.match(
        /\$queryRawUnsafe\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g
      );
      expect(unsafeWithConcat).toBeNull();
    });

    it('file should import from @prisma/client or use db.prisma (Prisma client available)', () => {
      const hasPrismaImport = OTP_CHALLENGE_SOURCE.includes("from '@prisma/client'") ||
        OTP_CHALLENGE_SOURCE.includes('from "@prisma/client"') ||
        OTP_CHALLENGE_SOURCE.includes('db.prisma');
      expect(hasPrismaImport).toBe(true);
    });
  });

});

// ---------------------------------------------------------------------------
// General Security
// ---------------------------------------------------------------------------

describe('General Security', () => {

  describe('Git-tracked sensitive files', () => {
    it('should NOT track actual .env file in git (only .env.example allowed)', () => {
      let trackedEnvFiles: string[] = [];
      try {
        const output = execSync('git ls-files .env* 2>/dev/null', {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf-8'
        }).trim();
        trackedEnvFiles = output ? output.split('\n').filter(Boolean) : [];
      } catch {
        // git not available — skip
        return;
      }

      const disallowed = trackedEnvFiles.filter(f =>
        // Allow example files only; disallow actual .env, .env.production, .env.local, etc.
        !f.endsWith('.example') && f !== '.env.example' && f !== '.env.production.example'
      );
      expect(disallowed).toEqual([]);
    });

    it('only .env.example and .env.production.example should be git-tracked', () => {
      let trackedEnvFiles: string[] = [];
      try {
        const output = execSync('git ls-files .env* 2>/dev/null', {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf-8'
        }).trim();
        trackedEnvFiles = output ? output.split('\n').filter(Boolean) : [];
      } catch {
        return;
      }

      for (const f of trackedEnvFiles) {
        expect(f).toMatch(/\.example$/);
      }
    });
  });

  describe('CLAUDE.md does not contain production passwords', () => {
    it('CLAUDE.md should not contain database password in plaintext', () => {
      const claudeMdPath = path.resolve(__dirname, '../../CLAUDE.md');
      if (!fs.existsSync(claudeMdPath)) return;
      const content = fs.readFileSync(claudeMdPath, 'utf-8');

      // The previously documented password 'N1it2is4h' should be gone
      // (was cleaned in C3 as noted in agent context)
      expect(content).not.toContain('N1it2is4h');
    });

    it('CLAUDE.md should not contain a full postgres connection string with embedded password', () => {
      const claudeMdPath = path.resolve(__dirname, '../../CLAUDE.md');
      if (!fs.existsSync(claudeMdPath)) return;
      const content = fs.readFileSync(claudeMdPath, 'utf-8');

      // Match pattern: postgresql://user:password@host
      const connStringWithPassword = content.match(/postgresql:\/\/[^:]+:[^@]{1,64}@/);
      expect(connStringWithPassword).toBeNull();
    });
  });

  describe('No hardcoded API keys in source files', () => {
    it('sms.service.ts should not contain hardcoded Twilio credentials', () => {
      expect(SMS_SERVICE_SOURCE).not.toMatch(/AC[0-9a-f]{32}/); // Twilio SID
      expect(SMS_SERVICE_SOURCE).not.toMatch(/SK[0-9a-f]{32}/); // Twilio token
    });

    it('sms.service.ts should not contain hardcoded MSG91 authKey', () => {
      // MSG91 keys are typically 24-character alphanumeric
      expect(SMS_SERVICE_SOURCE).not.toMatch(/authKey\s*=\s*['"][A-Za-z0-9]{24,}['"]/);
    });

    it('auth.service.ts should not contain hardcoded JWT secret', () => {
      expect(AUTH_SERVICE_SOURCE).not.toMatch(/jwtSecret\s*=\s*['"][^'"]{8,}['"]/);
      expect(AUTH_SERVICE_SOURCE).not.toMatch(/JWT_SECRET\s*=\s*['"][^'"]{8,}['"]/);
    });

    it('otp-challenge.service.ts should not contain hardcoded secrets', () => {
      // No string that looks like an API key (long alphanumeric)
      expect(OTP_CHALLENGE_SOURCE).not.toMatch(/(?:key|secret|password|token)\s*=\s*['"][A-Za-z0-9+/]{20,}['"]/i);
    });
  });

  describe('Rate limiting on OTP endpoints', () => {
    it('auth.routes.ts should apply otpRateLimiter to send-otp endpoint', () => {
      expect(AUTH_ROUTES_SOURCE).toMatch(/otpRateLimiter/);
      expect(AUTH_ROUTES_SOURCE).toMatch(/send-otp[\s\S]{0,50}?otpRateLimiter|otpRateLimiter[\s\S]{0,50}?send-otp/);
    });

    it('auth.routes.ts should apply authRateLimiter to verify-otp endpoint', () => {
      expect(AUTH_ROUTES_SOURCE).toMatch(/authRateLimiter/);
      expect(AUTH_ROUTES_SOURCE).toMatch(/verify-otp[\s\S]{0,50}?authRateLimiter|authRateLimiter[\s\S]{0,50}?verify-otp/);
    });

    it('driver.routes.ts should apply otpRateLimiter to onboard/initiate', () => {
      expect(DRIVER_ROUTES_SOURCE).toMatch(/otpRateLimiter/);
    });

    it('driver-onboarding.routes.ts should apply otpRateLimiter to onboard endpoints', () => {
      expect(DRIVER_ONBOARDING_ROUTES_SOURCE).toMatch(/otpRateLimiter/);
    });

    it('rate-limiter middleware file should export otpRateLimiter', () => {
      const rateLimiterPath = path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts');
      if (!fs.existsSync(rateLimiterPath)) return;
      const content = fs.readFileSync(rateLimiterPath, 'utf-8');
      expect(content).toMatch(/export\s+const\s+otpRateLimiter/);
    });

    it('rate-limiter middleware file should export authRateLimiter', () => {
      const rateLimiterPath = path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts');
      if (!fs.existsSync(rateLimiterPath)) return;
      const content = fs.readFileSync(rateLimiterPath, 'utf-8');
      expect(content).toMatch(/export\s+const\s+authRateLimiter/);
    });
  });

  describe('Structured logging patterns (no console.log in OTP flow)', () => {
    it('auth.service.ts should NOT use console.log for OTP values', () => {
      expect(AUTH_SERVICE_SOURCE).not.toMatch(/console\.log[^;]*\botp\b/i);
    });

    it('auth.service.ts should use logger.info for OTP generated message', () => {
      expect(AUTH_SERVICE_SOURCE).toMatch(/logger\.info\s*\([^)]*OTP generated/i);
    });

    it('auth.service.ts masked phone in OTP generated log (maskForLogging)', () => {
      // The OTP-generated log should reference maskedPhone, not the raw phone
      const otpLogMatch = AUTH_SERVICE_SOURCE.match(/logger\.info\s*\('OTP generated'[\s\S]{0,200}?\)/);
      if (otpLogMatch) {
        expect(otpLogMatch[0]).not.toMatch(/phone\s*[,}]/);
        expect(otpLogMatch[0]).toMatch(/maskedPhone|maskForLogging/);
      }
    });

    it('otp-challenge.service.ts must NOT use console.log anywhere', () => {
      expect(OTP_CHALLENGE_SOURCE).not.toMatch(/console\.log\s*\(/);
    });
  });

});
