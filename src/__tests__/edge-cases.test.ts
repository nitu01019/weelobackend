export {};

import { maskPhoneForExternal } from '../shared/utils/pii.utils';
import { getErrorMessage } from '../shared/utils/error.utils';
import { clampPageSize, MAX_PAGE_SIZE } from '../shared/utils/validation.utils';

describe('Edge Cases', () => {
  describe('Phone Masking Edge Cases', () => {
    it('handles exactly 4 digit number', () => {
      const result = maskPhoneForExternal('1234');
      expect(result).toBe('******1234');
    });

    it('handles 5 digit number', () => {
      const result = maskPhoneForExternal('12345');
      expect(result.endsWith('2345')).toBe(true);
    });

    it('handles very long number', () => {
      const result = maskPhoneForExternal('123456789012345');
      expect(result.endsWith('2345')).toBe(true);
    });

    it('handles number with special chars', () => {
      const result = maskPhoneForExternal('(+91) 987-654-3210');
      expect(result).toBe('******3210');
    });

    it('handles numeric input coerced to string', () => {
      const result = maskPhoneForExternal(9876543210 as any);
      expect(result).toBe('******3210');
    });

    it('handles boolean input gracefully', () => {
      // String(true) = 'true', replace(/\D/g,'') = '', length < 4 => '****'
      const result = maskPhoneForExternal(true as any);
      expect(result).toBe('****');
    });
  });

  describe('Error Handling Edge Cases', () => {
    it('getErrorMessage handles Error with empty message', () => {
      expect(getErrorMessage(new Error(''))).toBe('');
    });

    it('getErrorMessage handles Error subclass', () => {
      class CustomError extends Error {
        constructor(msg: string) { super(msg); this.name = 'CustomError'; }
      }
      expect(getErrorMessage(new CustomError('custom'))).toBe('custom');
    });

    it('getErrorMessage handles object with message property', () => {
      // Objects with .message are NOT Error instances
      expect(getErrorMessage({ message: 'fake' })).toBe('Unknown error');
    });

    it('getErrorMessage handles empty string', () => {
      expect(getErrorMessage('')).toBe('');
    });
  });

  describe('Pagination Edge Cases', () => {
    it('clampPageSize handles negative numbers', () => {
      expect(clampPageSize(-5)).toBe(20); // default
    });

    it('clampPageSize handles exactly MAX_PAGE_SIZE', () => {
      expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    });

    it('clampPageSize handles MAX_PAGE_SIZE + 1', () => {
      expect(clampPageSize(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    });

    it('clampPageSize handles float', () => {
      // Number(10.7) is 10.7, >= 1, Math.min(10.7, 100) = 10.7
      const result = clampPageSize(10.7);
      expect(result).toBe(10.7);
    });

    it('clampPageSize handles Infinity', () => {
      expect(clampPageSize(Infinity)).toBe(MAX_PAGE_SIZE);
    });

    it('clampPageSize handles empty string', () => {
      // parseInt('', 10) is NaN => returns default 20
      expect(clampPageSize('')).toBe(20);
    });
  });

  describe('Zod Queue Payloads', () => {
    it('queue payload schemas are importable', () => {
      const payloads = require('../shared/types/queue-payloads');
      expect(payloads).toBeDefined();
    });
  });

  describe('Socket Events', () => {
    it('SocketEvent has required events', () => {
      // F-C-52: SocketEvent map moved to packages/contracts/events.generated.ts;
      // read both so `.toContain(name)` matches whether inline or imported.
      const fs = require('fs');
      const path = require('path');
      const socketSrc = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'services', 'socket.service.ts'),
        'utf-8'
      );
      const contractsPath = path.join(__dirname, '..', '..', 'packages', 'contracts', 'events.generated.ts');
      const contractsSrc = fs.existsSync(contractsPath) ? fs.readFileSync(contractsPath, 'utf-8') : '';
      const content = socketSrc + '\n' + contractsSrc;
      expect(content).toContain('ASSIGNMENT_TIMEOUT');
      expect(content).toContain('BOOKING_CANCELLED');
      expect(content).toContain('DRIVER_PRESENCE_TIMEOUT');
      expect(content).toContain('CONNECTED');
      expect(content).toContain('NEW_BROADCAST');
    });
  });
});
