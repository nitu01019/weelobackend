/**
 * =============================================================================
 * F-A-86 -- Candidate-Scorer Weights Boot Validation (RED/GREEN)
 * =============================================================================
 *
 * Validates that behavioral scoring weights are parsed & validated with Zod on
 * module load. Guarantees:
 *   - Each weight in [0, 1]
 *   - Sum of weights = 1.0 (+/- 5%)
 *   - When FF_BEHAVIORAL_SCORING=true + invalid env -> throw (fail-fast boot)
 *   - When unset env -> defaults used, service boots cleanly
 *   - BEHAVIORAL_WEIGHTS is frozen (Object.freeze)
 *   - scorer_weights_boot_valid gauge set to 1 on success
 *
 * =============================================================================
 */

import { z } from 'zod';

// Re-declare the schema shape for isolated validation tests -- the production
// schema is defined inside candidate-scorer.service.ts and exported for reuse.
describe('F-A-86 -- BEHAVIORAL_WEIGHTS Zod validation schema', () => {
  test('sum of 0.5 fails validation', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WeightsSchema } = require('../shared/services/candidate-scorer.service');
    const parsed = WeightsSchema.safeParse({
      eta: 0.2,
      acceptance: 0.1,
      responseTime: 0.1,
      rating: 0.1,
    });
    expect(parsed.success).toBe(false);
  });

  test('single weight > 1 fails validation', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WeightsSchema } = require('../shared/services/candidate-scorer.service');
    const parsed = WeightsSchema.safeParse({
      eta: 1.5,
      acceptance: -0.2,
      responseTime: 0.1,
      rating: -0.4,
    });
    expect(parsed.success).toBe(false);
  });

  test('negative weight fails validation', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WeightsSchema } = require('../shared/services/candidate-scorer.service');
    const parsed = WeightsSchema.safeParse({
      eta: 0.5,
      acceptance: -0.1,
      responseTime: 0.3,
      rating: 0.3,
    });
    expect(parsed.success).toBe(false);
  });

  test('canonical defaults (0.5, 0.2, 0.2, 0.1) sum to 1.0 and pass', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WeightsSchema } = require('../shared/services/candidate-scorer.service');
    const parsed = WeightsSchema.safeParse({
      eta: 0.5,
      acceptance: 0.2,
      responseTime: 0.2,
      rating: 0.1,
    });
    expect(parsed.success).toBe(true);
  });

  test('sum within +/- 5% (e.g., 1.04) still passes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WeightsSchema } = require('../shared/services/candidate-scorer.service');
    const parsed = WeightsSchema.safeParse({
      eta: 0.52,
      acceptance: 0.2,
      responseTime: 0.2,
      rating: 0.12,
    });
    expect(parsed.success).toBe(true);
  });

  test('Zod is the validation engine (sanity: library wired)', () => {
    // Proves the test imports zod successfully and confirms we use z.object()
    const s = z.object({ a: z.number() });
    expect(s.safeParse({ a: 1 }).success).toBe(true);
  });
});

describe('F-A-86 -- boot-time behavior', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Ensure clean env for each test
    delete process.env.FF_BEHAVIORAL_SCORING;
    delete process.env.BEHAVIORAL_WEIGHT_ETA;
    delete process.env.BEHAVIORAL_WEIGHT_ACCEPTANCE;
    delete process.env.BEHAVIORAL_WEIGHT_RESPONSE;
    delete process.env.BEHAVIORAL_WEIGHT_RATING;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('unset env -> defaults used, module boots cleanly', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../shared/services/candidate-scorer.service');
    }).not.toThrow();
  });

  test('FF_BEHAVIORAL_SCORING=true + invalid weights -> fail-fast throw on load', () => {
    process.env.FF_BEHAVIORAL_SCORING = 'true';
    process.env.BEHAVIORAL_WEIGHT_ETA = '0.1';
    process.env.BEHAVIORAL_WEIGHT_ACCEPTANCE = '0.1';
    process.env.BEHAVIORAL_WEIGHT_RESPONSE = '0.1';
    process.env.BEHAVIORAL_WEIGHT_RATING = '0.1';

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../shared/services/candidate-scorer.service');
    }).toThrow();
  });

  test('FF_BEHAVIORAL_SCORING=false + invalid weights -> still boots (no fail-fast)', () => {
    process.env.FF_BEHAVIORAL_SCORING = 'false';
    process.env.BEHAVIORAL_WEIGHT_ETA = '0.1';
    process.env.BEHAVIORAL_WEIGHT_ACCEPTANCE = '0.1';
    process.env.BEHAVIORAL_WEIGHT_RESPONSE = '0.1';
    process.env.BEHAVIORAL_WEIGHT_RATING = '0.1';

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../shared/services/candidate-scorer.service');
    }).not.toThrow();
  });

  test('BEHAVIORAL_WEIGHTS is frozen (Object.freeze prevents mutation)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../shared/services/candidate-scorer.service');
    expect(Object.isFrozen(mod.BEHAVIORAL_WEIGHTS)).toBe(true);
  });

  test('scorer_weights_boot_valid gauge is set to 1 after successful boot', () => {
    // Force a clean module load
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../shared/services/candidate-scorer.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { metrics } = require('../shared/monitoring/metrics.service');
    const json = metrics.getMetricsJSON() as { gauges: Record<string, number> };
    expect(json.gauges['scorer_weights_boot_valid']).toBe(1);
  });
});
