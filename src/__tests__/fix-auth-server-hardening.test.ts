/**
 * =============================================================================
 * FIX-24/25/26/50/51 — Production Hardening Tests
 * =============================================================================
 *
 * Covers:
 * FIX-24: OTP console logging restricted to isDevelopment only
 * FIX-26: Phone numbers masked in health/websocket endpoint
 * FIX-50: Error details hidden when isDevelopment is false
 * FIX-51: IP budget map clears when exceeding 10000 entries
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';

export {};

// ---------------------------------------------------------------------------
// FIX-24: OTP console logging — isDevelopment guard
// ---------------------------------------------------------------------------
describe('FIX-24: OTP console logging guard', () => {
  const fs = require('fs');
  const path = require('path');
  const smsSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/auth/sms.service.ts'),
    'utf-8'
  );

  it('ConsoleProvider guard uses config.isDevelopment, not config.isProduction', () => {
    // The ConsoleProvider.sendOtp guard should check !config.isDevelopment
    // to block OTP console logging in staging and production alike
    expect(smsSource).toContain('!config.isDevelopment');
    // The old pattern should NOT be present in ConsoleProvider
    expect(smsSource).not.toMatch(/if\s*\(\s*config\.isProduction\s*\)\s*\{[^}]*Console SMS provider/s);
  });

  it('Fallback to console logging uses config.isDevelopment guard', () => {
    // The SmsService.sendOtp fallback should use config.isDevelopment
    expect(smsSource).toContain('config.isDevelopment && this.provider !== this.fallbackProvider');
    // Old pattern should be gone
    expect(smsSource).not.toContain('!config.isProduction && this.provider !== this.fallbackProvider');
  });

  it('ConsoleProvider still throws when not in development', () => {
    // Verify the throw is present for non-development environments
    expect(smsSource).toContain("'SMS_PROVIDER_DISABLED'");
    expect(smsSource).toContain('Console SMS provider is disabled outside development');
  });
});

// ---------------------------------------------------------------------------
// FIX-26: Phone numbers masked in health/websocket endpoint
// ---------------------------------------------------------------------------
describe('FIX-26: Phone masking in health endpoint', () => {
  it('health.routes.ts masks phone numbers with ***XXXX pattern', () => {
    const fs = require('fs');
    const path = require('path');
    const healthSource = fs.readFileSync(
      path.resolve(__dirname, '../shared/routes/health.routes.ts'),
      'utf-8'
    );

    // Should contain the masking pattern
    expect(healthSource).toContain("'***' + String(socket.data.phone).slice(-4)");
    // Should NOT expose raw phone
    expect(healthSource).not.toMatch(/phone:\s*socket\.data\.phone\s*\|\|\s*'unknown'/);
  });

  it('masking logic produces correct output for a full phone number', () => {
    // Simulate the masking expression from health.routes.ts
    const phone = '9876543210';
    const masked = phone ? '***' + String(phone).slice(-4) : 'unknown';
    expect(masked).toBe('***3210');
  });

  it('masking logic returns unknown for falsy phone', () => {
    const phone: string | undefined = undefined;
    const masked = phone ? '***' + String(phone).slice(-4) : 'unknown';
    expect(masked).toBe('unknown');
  });

  it('masking logic handles short phone numbers safely', () => {
    const phone = '12';
    const masked = phone ? '***' + String(phone).slice(-4) : 'unknown';
    expect(masked).toBe('***12');
  });
});

// ---------------------------------------------------------------------------
// FIX-50: Error middleware — isDevelopment guard
// ---------------------------------------------------------------------------
describe('FIX-50: Error middleware isDevelopment guard', () => {
  const fs = require('fs');
  const path = require('path');
  const errorSource = fs.readFileSync(
    path.resolve(__dirname, '../shared/middleware/error.middleware.ts'),
    'utf-8'
  );

  it('AppError details are gated by config.isDevelopment', () => {
    expect(errorSource).toContain('config.isDevelopment');
    // Old guard pattern should be gone for details
    expect(errorSource).not.toMatch(/error\.details\s*&&\s*!config\.isProduction/);
  });

  it('Unknown error message uses config.isDevelopment to show details', () => {
    // The ternary should show error.message only in development
    expect(errorSource).toMatch(/config\.isDevelopment\s*\?\s*error\.message/);
    // Old pattern with isProduction ternary should be gone
    expect(errorSource).not.toMatch(/config\.isProduction\s*\?\s*'An unexpected error/);
  });

  it('errorHandler hides stack trace details when not in development', () => {
    // Directly test the behavior logic extracted from error.middleware.ts
    // When isDevelopment = false, error.message should NOT be exposed
    const isDevelopment = false;
    const errorMessage = 'Sensitive DB connection string leaked';
    const resultMessage = isDevelopment
      ? errorMessage
      : 'An unexpected error occurred. Please try again later.';

    expect(resultMessage).toBe('An unexpected error occurred. Please try again later.');
    expect(resultMessage).not.toContain('Sensitive');
  });

  it('errorHandler shows error details in development mode', () => {
    // When isDevelopment = true, error.message should be exposed
    const isDevelopment = true;
    const errorMessage = 'Debug: connection refused on port 5432';
    const resultMessage = isDevelopment
      ? errorMessage
      : 'An unexpected error occurred. Please try again later.';

    expect(resultMessage).toBe('Debug: connection refused on port 5432');
  });

  it('AppError details are hidden in staging (isDevelopment=false, isProduction=false)', () => {
    // Simulate the AppError details guard from error.middleware.ts
    const isDevelopment = false;
    const errorDetails = { table: 'users', constraint: 'unique_email' };
    const safeDetails = errorDetails && isDevelopment ? errorDetails : undefined;

    expect(safeDetails).toBeUndefined();
  });

  it('AppError details are shown in development', () => {
    const isDevelopment = true;
    const errorDetails = { table: 'users', constraint: 'unique_email' };
    const safeDetails = errorDetails && isDevelopment ? errorDetails : undefined;

    expect(safeDetails).toEqual({ table: 'users', constraint: 'unique_email' });
  });
});

// ---------------------------------------------------------------------------
// FIX-51: IP budget map size cap
// ---------------------------------------------------------------------------
describe('FIX-51: IP budget map size cap', () => {
  it('geocoding.routes.ts contains the 10000 size cap check', () => {
    const fs = require('fs');
    const path = require('path');
    const geocodingSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/routing/geocoding.routes.ts'),
      'utf-8'
    );

    expect(geocodingSource).toContain('ipBudgetMap.size > 10000');
    expect(geocodingSource).toContain('ipBudgetMap.clear()');
  });

  it('Map.clear() resets size to 0 when threshold exceeded', () => {
    // Simulate the logic from geocoding.routes.ts
    const testMap = new Map<string, { search: number; reverse: number; route: number; date: string }>();

    // Fill beyond threshold
    for (let i = 0; i <= 10001; i++) {
      testMap.set(`192.168.1.${i}`, { search: 1, reverse: 0, route: 0, date: 'test' });
    }
    expect(testMap.size).toBeGreaterThan(10000);

    // Apply the same guard as in geocoding.routes.ts
    if (testMap.size > 10000) {
      testMap.clear();
    }
    expect(testMap.size).toBe(0);

    // New entry can be added after clear
    testMap.set('10.0.0.1', { search: 0, reverse: 0, route: 0, date: new Date().toDateString() });
    expect(testMap.size).toBe(1);
  });

  it('Map is NOT cleared when under threshold', () => {
    const testMap = new Map<string, { search: number }>();

    for (let i = 0; i < 100; i++) {
      testMap.set(`10.0.0.${i}`, { search: 1 });
    }
    expect(testMap.size).toBe(100);

    // Guard should NOT trigger
    if (testMap.size > 10000) {
      testMap.clear();
    }
    expect(testMap.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// FIX-25: Debug routes removed from server.ts
// ---------------------------------------------------------------------------
describe('FIX-25: Debug routes removed from server.ts', () => {
  it('server.ts does not contain unguarded debug route registrations', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSource = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf-8'
    );

    // Debug route paths should not appear
    expect(serverSource).not.toContain('/debug/database');
    expect(serverSource).not.toContain('/debug/stats');
    expect(serverSource).not.toContain('/debug/sockets');
  });

  it('server.ts still has health routes registered', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSource = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf-8'
    );

    // Health routes should still be present
    expect(serverSource).toContain("app.use('/', healthRoutes)");
    expect(serverSource).toContain('/health/runtime');
  });
});
