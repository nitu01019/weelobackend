/**
 * =============================================================================
 * NEW#3 — FCM phantom-key surgery (Juniper's patch)
 * =============================================================================
 *
 * Source-contract test for queue.service.ts FCM_BATCH consumer (lines ~1846-1962).
 *
 *   - Phantom keys gone: `redisService.del('fcm_token:${...}')` writes are
 *     removed from CODE PATHS (only the explanatory comment may remain).
 *   - Consumer now accepts BOTH legacy `{tokens: string[]}` and Round-6
 *     widened `{recipients: Array<{userId, token}>}` payload shapes — see
 *     §5.3 lines 2497, 2588-2592 of index-20-validated.md.
 *   - DEAD_TOKEN_CODES is the strict 2-code set:
 *       'messaging/registration-token-not-registered'
 *       'messaging/invalid-registration-token'
 *     and does NOT widen to messaging/invalid-argument (would wipe payload-bug
 *     batches).
 *   - Dead-token cleanup goes through `cleanupDeadToken(token)` →
 *     fcmService.removeToken(userId, token), which is the canonical
 *     SREM-on-fcm:tokens:{userId} path (fcm.service.ts).
 *   - cleanupDeadToken is gated on userId being present (legacy shape with no
 *     userId logs a warn and skips — does not call removeToken with undefined).
 *
 * Producer at ~:2590-2629 INTENTIONALLY UNTOUCHED per sequential rollout.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const mock_new3_queuePath = path.resolve(
  __dirname,
  '../shared/services/queue.service.ts'
);
const mock_new3_fcmPath = path.resolve(__dirname, '../shared/services/fcm.service.ts');

describe('NEW#3 — FCM phantom-key consumer rewrite', () => {
  let mock_new3_queueSrc: string;
  let mock_new3_fcmSrc: string;

  beforeAll(() => {
    mock_new3_queueSrc = fs.readFileSync(mock_new3_queuePath, 'utf8');
    mock_new3_fcmSrc = fs.readFileSync(mock_new3_fcmPath, 'utf8');
  });

  describe('phantom-key elimination', () => {
    it('no live `redisService.del(`fcm_token:` calls remain', () => {
      // Strip multi-line and single-line comments, then check.
      const stripped = mock_new3_queueSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
      expect(stripped).not.toMatch(/redisService\.del\s*\(\s*[`'"]fcm_token:/);
    });

    it("no live template literal write to 'fcm_token:${token}' remains", () => {
      const stripped = mock_new3_queueSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
      // Phantom write pattern: del with `fcm_token:${...}`
      expect(stripped).not.toMatch(/del\s*\(\s*`fcm_token:\$\{/);
    });
  });

  describe('dual-shape payload acceptance (FCM_BATCH consumer)', () => {
    it('declares recipients?: Array<{ userId: string; token: string }> on job.data', () => {
      expect(mock_new3_queueSrc).toMatch(
        /recipients\??\s*:\s*Array<\s*\{\s*userId:\s*string\s*;\s*token:\s*string\s*\}\s*>/
      );
    });

    it('keeps legacy tokens?: string[] in the same job.data shape', () => {
      // Locate the FCM_BATCH typed shape and assert tokens?: string[] is in it.
      const m = mock_new3_queueSrc.match(
        /const\s+data\s*=\s*job\.data\s+as\s*\{[\s\S]*?\}\s*;/
      );
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/recipients\??\s*:\s*Array</);
      expect(m![0]).toMatch(/tokens\??\s*:\s*string\[\]/);
    });

    it('coerces both shapes into a single recipients array (Array.isArray dispatch)', () => {
      // The coercion uses Array.isArray(data.recipients) ? ... : (Array.isArray(data.tokens) ? ...)
      expect(mock_new3_queueSrc).toMatch(/Array\.isArray\s*\(\s*data\.recipients\s*\)/);
      expect(mock_new3_queueSrc).toMatch(/Array\.isArray\s*\(\s*data\.tokens\s*\)/);
    });
  });

  describe('DEAD_TOKEN_CODES is the strict 2-code set', () => {
    it('contains exactly the 2 unambiguous codes', () => {
      const m = mock_new3_queueSrc.match(/DEAD_TOKEN_CODES\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/);
      expect(m).not.toBeNull();
      const body = m![1];
      expect(body).toMatch(/messaging\/registration-token-not-registered/);
      expect(body).toMatch(/messaging\/invalid-registration-token/);
      // Negative: must NOT contain the dangerous broad code.
      expect(body).not.toMatch(/messaging\/invalid-argument/);
    });
  });

  describe('cleanupDeadToken helper', () => {
    it('declares cleanupDeadToken async helper', () => {
      expect(mock_new3_queueSrc).toMatch(
        /const\s+cleanupDeadToken\s*=\s*async\s*\(\s*token\s*:\s*string\s*\)/
      );
    });

    it('routes through fcmService.removeToken(userId, token) — NOT redisService.del', () => {
      // Locate the helper body and assert it calls fcmService.removeToken.
      const m = mock_new3_queueSrc.match(
        /const\s+cleanupDeadToken[\s\S]*?\n\s*\};/
      );
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/fcmService\.removeToken\s*\(\s*userId\s*,\s*token\s*\)/);
      expect(m![0]).not.toMatch(/redisService\.del\s*\(/);
    });

    it('skips cleanup (warn + return) when userId is missing (legacy shape)', () => {
      const m = mock_new3_queueSrc.match(
        /const\s+cleanupDeadToken[\s\S]*?\n\s*\};/
      );
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/if\s*\(\s*!userId\s*\)/);
      expect(m![0]).toMatch(/userId\s+missing/);
    });

    it('cleanupDeadToken is the only cleanup path used in DEAD_TOKEN_CODES branches', () => {
      // Both error-handling branches (single-token fallback + multicast batch) call cleanupDeadToken.
      const matches = mock_new3_queueSrc.match(/await\s+cleanupDeadToken\s*\(\s*token/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('canonical removeToken implementation (consumer side)', () => {
    it('fcm.service.ts exports a removeToken(userId, token) method', () => {
      expect(mock_new3_fcmSrc).toMatch(/removeToken\s*\(\s*userId\s*:\s*string\s*,\s*token\s*:\s*string/);
    });
  });
});

export {};
