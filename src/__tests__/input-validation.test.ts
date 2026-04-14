/**
 * =============================================================================
 * INPUT VALIDATION TESTS
 * =============================================================================
 *
 * Tests for:
 * - clampPageSize utility (pagination cap)
 * - MAX_PAGE_SIZE constant
 *
 * @author Team FOXTROT -- P1 Security: Input Validation
 * =============================================================================
 */

export {};

import { clampPageSize, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../shared/utils/validation.utils';

describe('Input Validation', () => {
  describe('clampPageSize', () => {
    it('returns default for undefined', () => {
      expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('returns default for NaN', () => {
      expect(clampPageSize('abc')).toBe(DEFAULT_PAGE_SIZE);
    });

    it('caps at MAX_PAGE_SIZE for large values', () => {
      expect(clampPageSize(10000)).toBe(MAX_PAGE_SIZE);
    });

    it('returns default for 0', () => {
      expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('passes through normal values', () => {
      expect(clampPageSize(50)).toBe(50);
    });

    it('handles string numbers', () => {
      expect(clampPageSize('25')).toBe(25);
    });

    it('caps string large numbers', () => {
      expect(clampPageSize('999')).toBe(MAX_PAGE_SIZE);
    });

    it('uses custom default when provided', () => {
      expect(clampPageSize(undefined, 10)).toBe(10);
    });

    it('returns default for negative values', () => {
      expect(clampPageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('passes through value equal to MAX_PAGE_SIZE', () => {
      expect(clampPageSize(100)).toBe(100);
    });

    it('passes through value of 1 (minimum valid)', () => {
      expect(clampPageSize(1)).toBe(1);
    });

    it('returns default for empty string', () => {
      expect(clampPageSize('')).toBe(DEFAULT_PAGE_SIZE);
    });

    it('returns default for NaN-producing string', () => {
      expect(clampPageSize('not-a-number')).toBe(DEFAULT_PAGE_SIZE);
    });

    it('handles string "0"', () => {
      expect(clampPageSize('0')).toBe(DEFAULT_PAGE_SIZE);
    });

    it('handles string "100"', () => {
      expect(clampPageSize('100')).toBe(100);
    });

    it('handles string "101"', () => {
      expect(clampPageSize('101')).toBe(MAX_PAGE_SIZE);
    });
  });

  describe('MAX_PAGE_SIZE', () => {
    it('is 100', () => {
      expect(MAX_PAGE_SIZE).toBe(100);
    });
  });

  describe('DEFAULT_PAGE_SIZE', () => {
    it('is 20', () => {
      expect(DEFAULT_PAGE_SIZE).toBe(20);
    });
  });
});
