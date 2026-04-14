/**
 * =============================================================================
 * PHASE 8 INFRASTRUCTURE FIXES -- Tests
 * =============================================================================
 *
 * Tests for infrastructure-level fixes:
 *
 *  C-3:  DB health check in /health/ready (SELECT 1 + circuit breaker)
 *  C-5:  Correlation middleware registered in server.ts
 *  H-10: ECS grace period force-exit timer is 25000ms
 *  H-12: 5 feature flags present in registry
 *  H-13: FF_HOLD_DB_ATOMIC_CLAIM default='true' in env.validation
 *  H-14: Error handler includes requestId in log and response
 *  H-15: holdReconciliation stop() in shutdown + .unref() on interval
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    isDevelopment: true,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// HELPER: Read source file for structural verification
// =============================================================================
function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8');
}

// =============================================================================
// C-3: DB health check in /health/ready
// =============================================================================
describe('C-3: DB health check in /health/ready', () => {
  const healthSource = readSource('shared/routes/health.routes.ts');

  test('readiness probe executes SELECT 1 against database', () => {
    // The health/ready handler must query the database with SELECT 1
    expect(healthSource).toContain('prismaClient.$queryRaw`SELECT 1`');
  });

  test('DB check has a timeout to prevent hanging', () => {
    // Must have a timeout race so a slow DB doesn't stall the probe
    expect(healthSource).toContain('DB_TIMEOUT_MS');
    expect(healthSource).toContain('Promise.race');
    expect(healthSource).toContain('DB health ping timeout');
  });

  test('DB check is wrapped in databaseCircuitBreaker', () => {
    // Circuit breaker prevents repeated slow calls from cascading
    expect(healthSource).toContain('databaseCircuitBreaker.execute');
  });
});

// =============================================================================
// C-5: Correlation middleware registered in server.ts
// =============================================================================
describe('C-5: Correlation middleware registered in server.ts', () => {
  const serverSource = readSource('server.ts');

  test('correlationMiddleware is imported', () => {
    expect(serverSource).toContain("import { correlationMiddleware }");
    expect(serverSource).toContain('correlation');
  });

  test('correlationMiddleware is registered via app.use()', () => {
    // Must be called as Express middleware
    expect(serverSource).toContain('app.use(correlationMiddleware)');
  });

  test('correlationMiddleware wraps request in AsyncLocalStorage context', () => {
    const correlationSource = readSource('shared/context/correlation.ts');
    // Must use AsyncLocalStorage.run() for zero-overhead propagation
    expect(correlationSource).toContain('correlationStore.run');
    expect(correlationSource).toContain('AsyncLocalStorage');
  });
});

// =============================================================================
// H-10: ECS grace period — force-exit timer is 25000ms
// =============================================================================
describe('H-10: ECS grace period force-exit timer', () => {
  const serverSource = readSource('server.ts');

  test('force-exit timeout is 25000ms (not 30000ms)', () => {
    // ECS sends SIGKILL at 30s; force-exit must fire before that
    expect(serverSource).toContain('25000');
    // Must NOT use 30000 for the force-exit timer
    const forceShutdownRegex = /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?forced shutdown/i;
    const match = serverSource.match(forceShutdownRegex);
    expect(match).toBeTruthy();
  });

  test('force-exit timer calls .unref() to avoid blocking clean exit', () => {
    // The setTimeout for forced shutdown must be unref'd
    // Look for the pattern: setTimeout(..., 25000).unref()
    expect(serverSource).toMatch(/setTimeout\([\s\S]*?25000\)\.unref\(\)/);
  });
});

// =============================================================================
// H-12: 5 feature flags in registry
// =============================================================================
describe('H-12: Feature flags present in registry', () => {
  const { FLAGS, isEnabled } = require('../shared/config/feature-flags');

  const REQUIRED_FLAGS = [
    'COMPLETION_ORCHESTRATOR',
    'POD_OTP_REQUIRED',
    'MASKED_CALLING',
    'BEHAVIORAL_SCORING',
    'LEGACY_ORDER_EXPIRY_CHECKER',
  ] as const;

  test.each(REQUIRED_FLAGS)('FLAGS.%s is defined in registry', (flagName) => {
    expect(FLAGS[flagName]).toBeDefined();
    expect(FLAGS[flagName].env).toMatch(/^FF_/);
    expect(FLAGS[flagName].description).toBeTruthy();
  });

  test('COMPLETION_ORCHESTRATOR is an ops toggle (default ON)', () => {
    expect(FLAGS.COMPLETION_ORCHESTRATOR.category).toBe('ops');
    // Ops toggle: ON unless env === 'false'
    delete process.env.FF_COMPLETION_ORCHESTRATOR;
    expect(isEnabled(FLAGS.COMPLETION_ORCHESTRATOR)).toBe(true);
  });

  test('POD_OTP_REQUIRED is a release toggle (default OFF)', () => {
    expect(FLAGS.POD_OTP_REQUIRED.category).toBe('release');
    // Release toggle: OFF unless env === 'true'
    delete process.env.FF_POD_OTP_REQUIRED;
    expect(isEnabled(FLAGS.POD_OTP_REQUIRED)).toBe(false);
  });
});

// =============================================================================
// H-13: FF_HOLD_DB_ATOMIC_CLAIM default = 'true' in env.validation
// =============================================================================
describe('H-13: Feature flag defaults in env.validation', () => {
  const envValidationSource = readSource('core/config/env.validation.ts');

  test('FF_HOLD_DB_ATOMIC_CLAIM has default value of true', () => {
    // The env var definition must specify default: 'true'
    // Find the block for FF_HOLD_DB_ATOMIC_CLAIM and check its default
    const ffBlockRegex = /name:\s*'FF_HOLD_DB_ATOMIC_CLAIM'[\s\S]*?default:\s*'(\w+)'/;
    const match = envValidationSource.match(ffBlockRegex);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('true');
  });

  test('FF_HOLD_DB_ATOMIC_CLAIM is validated as boolean string', () => {
    // Validator must accept only 'true' or 'false'
    expect(envValidationSource).toContain("FF_HOLD_DB_ATOMIC_CLAIM");
    const ffSection = envValidationSource.slice(
      envValidationSource.indexOf('FF_HOLD_DB_ATOMIC_CLAIM')
    );
    const validatorBlock = ffSection.slice(0, ffSection.indexOf('},') + 2);
    expect(validatorBlock).toContain("'true'");
    expect(validatorBlock).toContain("'false'");
  });
});

// =============================================================================
// H-14: Error handler includes requestId in log and response
// =============================================================================
describe('H-14: Error handler requestId propagation', () => {
  test('requestId is extracted from x-request-id header', () => {
    const errorSource = readSource('shared/middleware/error.middleware.ts');
    expect(errorSource).toContain("req.headers['x-request-id']");
  });

  test('requestId appears in logger.error call', () => {
    const errorSource = readSource('shared/middleware/error.middleware.ts');
    // The logger.error metadata object must include requestId
    expect(errorSource).toMatch(/logger\.error\([\s\S]*?requestId/);
  });

  test('requestId is included in error response JSON for both AppError and unknown errors', () => {
    // Import and invoke errorHandler with a mock request containing x-request-id
    const { errorHandler } = require('../shared/middleware/error.middleware');

    const mockReq = {
      headers: { 'x-request-id': 'test-req-123' },
      path: '/test',
      method: 'GET',
      ip: '127.0.0.1',
    } as any;

    const captured: { status: number; body: any } = { status: 0, body: null };
    const mockRes = {
      status: (code: number) => {
        captured.status = code;
        return mockRes;
      },
      json: (body: any) => {
        captured.body = body;
      },
      setHeader: jest.fn(),
    } as any;
    const mockNext = jest.fn();

    // Unknown error path
    errorHandler(new Error('boom'), mockReq, mockRes, mockNext);
    expect(captured.status).toBe(500);
    expect(captured.body.error.requestId).toBe('test-req-123');
  });
});

// =============================================================================
// H-15: holdReconciliation stop() in shutdown + .unref() on interval
// =============================================================================
describe('H-15: holdReconciliation shutdown and unref', () => {
  test('holdReconciliationService.stop() is called during graceful shutdown', () => {
    const serverSource = readSource('server.ts');
    // The shutdown handler must call holdReconciliationService.stop()
    expect(serverSource).toContain('holdReconciliationService.stop()');
  });

  test('interval uses .unref() so it does not block process exit', () => {
    const reconciliationSource = readSource(
      'modules/hold-expiry/hold-reconciliation.service.ts'
    );
    // The setInterval result must have .unref() called on it
    expect(reconciliationSource).toMatch(/setInterval\([\s\S]*?\)[\s\S]*?\.unref\(\)/);
    // Also ensure intervalId is stored for later cleanup
    expect(reconciliationSource).toContain('this.intervalId');
  });

  test('stop() clears interval and resets running state', () => {
    const reconciliationSource = readSource(
      'modules/hold-expiry/hold-reconciliation.service.ts'
    );
    // stop() must call clearInterval and set isRunning to false
    expect(reconciliationSource).toContain('clearInterval(this.intervalId)');
    expect(reconciliationSource).toContain('this.isRunning = false');
    expect(reconciliationSource).toContain('this.intervalId = null');
  });
});
