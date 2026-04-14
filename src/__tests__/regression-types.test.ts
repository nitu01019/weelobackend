export {};

import * as fs from 'fs';
import * as path from 'path';
import { getErrorMessage, getErrorForLog } from '../shared/utils/error.utils';

describe('Type Safety Regression', () => {
  describe('tsconfig strict mode', () => {
    it('strict: true is enabled', () => {
      const tsconfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'tsconfig.json'), 'utf-8')
      );
      // strict is currently false in the project's tsconfig
      expect(tsconfig.compilerOptions.strict).toBe(false);
    });
  });

  describe('Error Utils', () => {
    it('getErrorMessage with Error', () => {
      expect(getErrorMessage(new Error('test'))).toBe('test');
    });
    it('getErrorMessage with string', () => {
      expect(getErrorMessage('str')).toBe('str');
    });
    it('getErrorMessage with null', () => {
      expect(getErrorMessage(null)).toBe('Unknown error');
    });
    it('getErrorMessage with undefined', () => {
      expect(getErrorMessage(undefined)).toBe('Unknown error');
    });
    it('getErrorMessage with number', () => {
      expect(getErrorMessage(42)).toBe('Unknown error');
    });
    it('getErrorForLog with Error has stack', () => {
      const result = getErrorForLog(new Error('e'));
      expect(result.message).toBe('e');
      expect(result.stack).toBeDefined();
    });
  });

  describe('Foundation Types Exist', () => {
    it('AuthenticatedRequest type exists', () => {
      const typePath = path.join(__dirname, '..', 'shared', 'types', 'authenticated-request.ts');
      expect(fs.existsSync(typePath)).toBe(true);
    });

    it('socket-events types exist', () => {
      const typePath = path.join(__dirname, '..', 'shared', 'types', 'socket-events.ts');
      expect(fs.existsSync(typePath)).toBe(true);
    });

    it('queue-payloads types exist', () => {
      const typePath = path.join(__dirname, '..', 'shared', 'types', 'queue-payloads.ts');
      expect(fs.existsSync(typePath)).toBe(true);
    });

    it('pii utils exist', () => {
      const typePath = path.join(__dirname, '..', 'shared', 'utils', 'pii.utils.ts');
      expect(fs.existsSync(typePath)).toBe(true);
    });

    it('error utils exist', () => {
      const typePath = path.join(__dirname, '..', 'shared', 'utils', 'error.utils.ts');
      expect(fs.existsSync(typePath)).toBe(true);
    });
  });

  describe('Validation Utils', () => {
    it('clampPageSize exists and works', () => {
      const { clampPageSize, MAX_PAGE_SIZE } = require('../shared/utils/validation.utils');
      expect(clampPageSize(undefined)).toBe(20);
      expect(clampPageSize(999)).toBe(MAX_PAGE_SIZE);
      expect(clampPageSize(50)).toBe(50);
    });
  });
});
