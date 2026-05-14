/**
 * =============================================================================
 * Phase 7 follow-up — Defect #10: .env.example covers all new Phase 7 envs
 * =============================================================================
 *
 * Phase 7 introduced several new environment variables consumed via
 * `process.env.X === 'true'`. They have safe defaults (missing → false) so
 * they don't break production, but they were undocumented in `.env.example`
 * — new operators had to read source code to discover them.
 *
 * Fix: append the new vars to .env.example with safe defaults + inline
 * documentation about rollout-order constraints.
 *
 * Industry: 12-Factor App III §"Config" — explicit, discoverable environment.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ENV_EXAMPLE_PATH = join(__dirname, '..', '..', '.env.example');

describe('Phase 7 follow-up — Defect #10 .env.example covers all new Phase 7 envs', () => {
  let env: string;

  beforeAll(() => {
    env = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  });

  const REQUIRED_KEYS = [
    'FF_H3_DUAL_INDEX_WRITE',
    'FF_H3_DUAL_INDEX_READ',
    'FF_DURABLE_EMIT_ENABLED',
    'ECS_STOPTIMEOUT_CONFIRMED_GTE_45S',
    'REDIS_CLUSTER',
  ];

  it.each(REQUIRED_KEYS)('declares %s with a safe default', (key) => {
    // Each key must appear with an explicit assignment (`KEY=value`).
    // String-based scan to avoid `new RegExp(${key})` which trips Semgrep
    // javascript.lang.security.audit.detect-non-literal-regexp.
    const lines = env.split(/\r?\n/);
    expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(true);
  });

  it('all new flags default to safe values (false where boolean)', () => {
    // Each boolean flag must default to `false`, with `\b` semantics after the
    // value (next char is end-of-line or a non-word char like space, tab, #).
    const booleanDefaultFalse = [
      'FF_H3_DUAL_INDEX_WRITE',
      'FF_H3_DUAL_INDEX_READ',
      'FF_DURABLE_EMIT_ENABLED',
      'ECS_STOPTIMEOUT_CONFIRMED_GTE_45S',
      'REDIS_CLUSTER',
    ];
    const lines = env.split(/\r?\n/);
    for (const key of booleanDefaultFalse) {
      const prefix = `${key}=false`;
      const matched = lines.some((line) => {
        if (!line.startsWith(prefix)) return false;
        const after = line.charAt(prefix.length);
        // `\b` equivalent: empty (end of line) OR non-word char.
        return after === '' || /[^A-Za-z0-9_]/.test(after);
      });
      expect(matched).toBe(true);
    }
  });

  it('documents the ECS_STOPTIMEOUT taskdef precondition', () => {
    // Must mention the constraint on raising ECS stopTimeout to >= 45s BEFORE
    // flipping ECS_STOPTIMEOUT_CONFIRMED_GTE_45S=true. The comment may appear
    // BEFORE or AFTER the variable line — accept either ordering.
    expect(env).toMatch(
      /(?:ECS_STOPTIMEOUT_CONFIRMED_GTE_45S[\s\S]{0,400}stopTimeout|stopTimeout[\s\S]{0,400}ECS_STOPTIMEOUT_CONFIRMED_GTE_45S)/,
    );
  });
});
