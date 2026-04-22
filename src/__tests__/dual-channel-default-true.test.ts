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

/**
 * =============================================================================
 * Wave-3 W3-T22 — Feature-flag default-OFF invariants
 * =============================================================================
 *
 * Four flags introduced across Wave-2 (FCM_DATA_ONLY_FULLSCREEN) and Wave-3
 * (SERVER_CLOCK_ANCHOR, TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED,
 * ROLE_SCOPED_DURABLE_EMIT) MUST default OFF when the env var is unset.
 *
 * Each flag gates wire-contract or runtime-behaviour changes that require
 * staged roll-out coordinated with the Captain Android build / ops IOPS
 * pre-flight / staging soak window. A silent default-ON would ship the
 * changed behaviour before the roll-out gate is cleared.
 *
 * Plan reference: .planning/review-2026-04-21/CRITICAL_FIX_PLAN.md §9
 *                 Feature-flag audit table.
 * =============================================================================
 */
describe('W3-T22 FCM_DATA_ONLY_FULLSCREEN default=false', () => {
  const ENV_KEY = 'FF_FCM_DATA_ONLY_FULLSCREEN';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('defaults to FALSE when env var is NOT set', () => {
    delete process.env[ENV_KEY];
    expect(isEnabled(FLAGS.FCM_DATA_ONLY_FULLSCREEN)).toBe(false);
  });

  it('defaults to FALSE when env var is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isEnabled(FLAGS.FCM_DATA_ONLY_FULLSCREEN)).toBe(false);
  });

  it('respects explicit "true" override from operator', () => {
    process.env[ENV_KEY] = 'true';
    expect(isEnabled(FLAGS.FCM_DATA_ONLY_FULLSCREEN)).toBe(true);
  });

  it('flag carries the expected metadata', () => {
    expect(FLAGS.FCM_DATA_ONLY_FULLSCREEN.env).toBe('FF_FCM_DATA_ONLY_FULLSCREEN');
    expect(FLAGS.FCM_DATA_ONLY_FULLSCREEN.defaultValue).toBe(false);
    expect(FLAGS.FCM_DATA_ONLY_FULLSCREEN.category).toBe('release');
  });
});

describe('W3-T22 SERVER_CLOCK_ANCHOR default=false', () => {
  const ENV_KEY = 'FF_SERVER_CLOCK_ANCHOR';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('defaults to FALSE when env var is NOT set', () => {
    delete process.env[ENV_KEY];
    expect(isEnabled(FLAGS.SERVER_CLOCK_ANCHOR)).toBe(false);
  });

  it('defaults to FALSE when env var is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isEnabled(FLAGS.SERVER_CLOCK_ANCHOR)).toBe(false);
  });

  it('respects explicit "true" override from operator', () => {
    process.env[ENV_KEY] = 'true';
    expect(isEnabled(FLAGS.SERVER_CLOCK_ANCHOR)).toBe(true);
  });

  it('flag carries the expected metadata', () => {
    expect(FLAGS.SERVER_CLOCK_ANCHOR.env).toBe('FF_SERVER_CLOCK_ANCHOR');
    expect(FLAGS.SERVER_CLOCK_ANCHOR.defaultValue).toBe(false);
    expect(FLAGS.SERVER_CLOCK_ANCHOR.category).toBe('release');
  });
});

describe('W3-T22 TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED default=false', () => {
  const ENV_KEY = 'FF_TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('defaults to FALSE when env var is NOT set', () => {
    delete process.env[ENV_KEY];
    expect(isEnabled(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED)).toBe(false);
  });

  it('defaults to FALSE when env var is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isEnabled(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED)).toBe(false);
  });

  it('respects explicit "true" override from operator', () => {
    process.env[ENV_KEY] = 'true';
    expect(isEnabled(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED)).toBe(true);
  });

  it('flag carries the expected metadata', () => {
    expect(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED.env).toBe('FF_TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED');
    expect(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED.defaultValue).toBe(false);
    expect(FLAGS.TRIP_ASSIGNED_FANOUT_OUTBOX_ENABLED.category).toBe('release');
  });
});

describe('W3-T22 ROLE_SCOPED_DURABLE_EMIT default=false', () => {
  const ENV_KEY = 'FF_ROLE_SCOPED_DURABLE_EMIT';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('defaults to FALSE when env var is NOT set', () => {
    delete process.env[ENV_KEY];
    expect(isEnabled(FLAGS.ROLE_SCOPED_DURABLE_EMIT)).toBe(false);
  });

  it('defaults to FALSE when env var is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isEnabled(FLAGS.ROLE_SCOPED_DURABLE_EMIT)).toBe(false);
  });

  it('respects explicit "true" override from operator', () => {
    process.env[ENV_KEY] = 'true';
    expect(isEnabled(FLAGS.ROLE_SCOPED_DURABLE_EMIT)).toBe(true);
  });

  it('flag carries the expected metadata', () => {
    expect(FLAGS.ROLE_SCOPED_DURABLE_EMIT.env).toBe('FF_ROLE_SCOPED_DURABLE_EMIT');
    expect(FLAGS.ROLE_SCOPED_DURABLE_EMIT.defaultValue).toBe(false);
    expect(FLAGS.ROLE_SCOPED_DURABLE_EMIT.category).toBe('release');
  });
});
