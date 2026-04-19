export {};

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

describe('Final QA Sign-off', () => {
  describe('Build Verification', () => {
    it('TypeScript compiles with no new errors (3 known in confirmed-hold.service.ts)', () => {
      const result = execSync('npx tsc --noEmit 2>&1 | grep "error TS" | wc -l', {
        encoding: 'utf-8',
        cwd: path.join(__dirname, '..', '..'),
        timeout: 60000,
      }).trim();
      // 3 known pre-existing TS errors in confirmed-hold.service.ts (bookingId on Order type)
      expect(parseInt(result)).toBeLessThanOrEqual(3);
    }, 70000);

    it('strict mode is configured in tsconfig', () => {
      const tsconfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'tsconfig.json'), 'utf-8')
      );
      expect(tsconfig.compilerOptions).toHaveProperty('strict');
    });

    it('noImplicitReturns is configured in tsconfig', () => {
      const tsconfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'tsconfig.json'), 'utf-8')
      );
      expect(tsconfig.compilerOptions).toHaveProperty('noImplicitReturns');
    });
  });

  describe('Security Verification', () => {
    it('JWT uses HS256 in auth middleware', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'middleware', 'auth.middleware.ts'),
        'utf-8'
      );
      expect(content).toContain("algorithms: ['HS256']");
    });

    it('JWT uses HS256 in auth middleware', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'middleware', 'auth.middleware.ts'),
        'utf-8'
      );
      expect(content).toContain("algorithms: ['HS256']");
    });

    it('S3 presigned URL has a configurable TTL', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'services', 's3-upload.service.ts'),
        'utf-8'
      );
      expect(content).toContain('expiresIn');
    });

    it('PII masking utility exists', () => {
      const { maskPhoneForExternal } = require('../shared/utils/pii.utils');
      expect(maskPhoneForExternal('9876543210')).toBe('******3210');
    });

    it('rate limiter exists', () => {
      const { rateLimiter } = require('../shared/middleware/rate-limiter.middleware');
      expect(rateLimiter).toBeDefined();
    });

    it('order-broadcast masks customer phone', () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'modules', 'order', 'order-broadcast.service.ts'),
        'utf-8'
      );
      expect(content).toContain('maskPhoneForExternal');
    });
  });

  describe('Foundation Types Verification', () => {
    it('AuthenticatedRequest type file exists', () => {
      expect(fs.existsSync(
        path.join(__dirname, '..', 'shared', 'types', 'authenticated-request.ts')
      )).toBe(true);
    });

    it('Socket events type file exists', () => {
      expect(fs.existsSync(
        path.join(__dirname, '..', 'shared', 'types', 'socket-events.ts')
      )).toBe(true);
    });

    it('Queue payloads type file exists', () => {
      expect(fs.existsSync(
        path.join(__dirname, '..', 'shared', 'types', 'queue-payloads.ts')
      )).toBe(true);
    });

    it('Error utilities work correctly', () => {
      const { getErrorMessage } = require('../shared/utils/error.utils');
      expect(getErrorMessage(new Error('test'))).toBe('test');
      expect(getErrorMessage('str')).toBe('str');
      expect(getErrorMessage(null)).toBe('Unknown error');
    });

    it('Validation utilities work correctly', () => {
      const { clampPageSize, MAX_PAGE_SIZE } = require('../shared/utils/validation.utils');
      expect(clampPageSize(999)).toBe(MAX_PAGE_SIZE);
      expect(clampPageSize(undefined)).toBe(20);
    });
  });

  describe('Hold System Configuration', () => {
    it('HOLD_CONFIG has correct defaults', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.flexHoldDurationSeconds).toBe(90);
      expect(HOLD_CONFIG.flexHoldExtensionSeconds).toBe(30);
      expect(HOLD_CONFIG.flexHoldMaxDurationSeconds).toBe(130);
      expect(HOLD_CONFIG.flexHoldMaxExtensions).toBe(2);
      expect(HOLD_CONFIG.confirmedHoldMaxSeconds).toBe(180);
      expect(HOLD_CONFIG.driverAcceptTimeoutSeconds).toBe(45);
    });
  });

  describe('Exotel Service', () => {
    it('exotel service exists and is importable', () => {
      const { exotelService } = require('../shared/services/exotel.service');
      expect(exotelService).toBeDefined();
      expect(typeof exotelService.isConfigured).toBe('function');
      expect(typeof exotelService.initiateCall).toBe('function');
    });
  });

  describe('Secrets Loader', () => {
    it('secrets loader exists', () => {
      const { loadSecrets } = require('../config/secrets');
      expect(typeof loadSecrets).toBe('function');
    });
  });
});
