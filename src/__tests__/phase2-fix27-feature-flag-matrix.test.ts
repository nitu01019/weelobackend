// Phase 2 Fix #27 — CI all-flags-on / all-flags-off matrix.
//
// Locks in the global FF_ALL_OFF / FF_ALL_ON env overrides on isEnabled.
// Path B (lead-approved 2026-05-13): placeholder-category carve-out is
// DEFERRED — FlagCategory at HEAD ee4cd6e8 is 'ops' | 'release' only.
// Solution test cases (c), (d), (f) require placeholder; dropped here.
// New cases (g), (h) lock the kill-switch / global-on precedence over per-flag env.

import { isEnabled } from '../shared/config/feature-flags';

const opsFlag = {
  env: 'FF_TEST_OPS_FIX27',
  defaultValue: false,
  category: 'ops' as const,
  description: 'test fixture for Fix #27 matrix — never used by production code',
};

describe('Phase 2 Fix #27 — feature-flag matrix (FF_ALL_OFF / FF_ALL_ON)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.FF_ALL_ON;
    delete process.env.FF_ALL_OFF;
    delete process.env.FF_TEST_OPS_FIX27;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('(a) FF_ALL_ON=1 + ops flag → true', () => {
    process.env.FF_ALL_ON = '1';
    expect(isEnabled(opsFlag)).toBe(true);
  });

  it('(b) FF_ALL_OFF=1 + ops flag → false', () => {
    process.env.FF_ALL_OFF = '1';
    expect(isEnabled(opsFlag)).toBe(false);
  });

  it('(e) both globals unset + per-flag env=true → true (per-flag wins)', () => {
    process.env.FF_TEST_OPS_FIX27 = 'true';
    expect(isEnabled(opsFlag)).toBe(true);
  });

  it('(g) FF_ALL_OFF=1 + per-flag env=true → false (kill-switch wins over per-flag)', () => {
    process.env.FF_ALL_OFF = '1';
    process.env.FF_TEST_OPS_FIX27 = 'true';
    expect(isEnabled(opsFlag)).toBe(false);
  });

  it('(h) FF_ALL_ON=1 + per-flag env=false → true (global ON wins over per-flag false)', () => {
    process.env.FF_ALL_ON = '1';
    process.env.FF_TEST_OPS_FIX27 = 'false';
    expect(isEnabled(opsFlag)).toBe(true);
  });
});
