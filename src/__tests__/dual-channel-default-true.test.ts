/**
 * =============================================================================
 * F-B-53 — Dual-channel delivery default=true
 * =============================================================================
 *
 * Asserts that `isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY)` returns `true` even
 * when the env var is NOT set. This validates the LaunchDarkly safe-default
 * pattern: the flag declares `defaultValue: true`, which overrides the
 * 'release' category's implicit OFF default.
 *
 * Previously this flag was OFF when unset → silent FCM fallback loss for
 * critical broadcast events.
 * =============================================================================
 */

export {};

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { FLAGS, isEnabled } from '../shared/config/feature-flags';

describe('F-B-53 DUAL_CHANNEL_DELIVERY default=true', () => {
  const ENV_KEY = 'FF_DUAL_CHANNEL_DELIVERY';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('defaults to TRUE when env var is NOT set (explicit defaultValue)', () => {
    delete process.env[ENV_KEY];
    expect(isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY)).toBe(true);
  });

  it('defaults to TRUE when env var is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY)).toBe(true);
  });

  it('respects explicit "false" override from operator', () => {
    process.env[ENV_KEY] = 'false';
    expect(isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY)).toBe(false);
  });

  it('respects explicit "true" override', () => {
    process.env[ENV_KEY] = 'true';
    expect(isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY)).toBe(true);
  });

  it('flag carries the expected metadata', () => {
    expect(FLAGS.DUAL_CHANNEL_DELIVERY.env).toBe('FF_DUAL_CHANNEL_DELIVERY');
    expect(FLAGS.DUAL_CHANNEL_DELIVERY.defaultValue).toBe(true);
    expect(FLAGS.DUAL_CHANNEL_DELIVERY.category).toBe('release');
  });

  // Guards against regressions of the isEnabled() function itself:
  it('category "release" flag WITHOUT explicit defaultValue still defaults OFF', () => {
    // MASKED_CALLING is declared release, no defaultValue → should remain OFF.
    const flag = FLAGS.MASKED_CALLING;
    const key = flag.env;
    const prev = process.env[key];
    try {
      delete process.env[key];
      expect(isEnabled(flag)).toBe(false);
    } finally {
      if (prev !== undefined) process.env[key] = prev;
    }
  });

  it('category "ops" flag defaults ON (unchanged behavior)', () => {
    const flag = FLAGS.CIRCUIT_BREAKER_ENABLED;
    const key = flag.env;
    const prev = process.env[key];
    try {
      delete process.env[key];
      expect(isEnabled(flag)).toBe(true);
    } finally {
      if (prev !== undefined) process.env[key] = prev;
    }
  });
});
