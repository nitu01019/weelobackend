import { maskPhoneForExternal, maskPhoneForLog } from '../shared/utils/pii.utils';

describe('PII Masking', () => {
  describe('maskPhoneForExternal', () => {
    it('masks 10-digit Indian phone', () => {
      expect(maskPhoneForExternal('9876543210')).toBe('******3210');
    });

    it('masks phone with +91 prefix', () => {
      expect(maskPhoneForExternal('+919876543210')).toBe('******3210');
    });

    it('masks phone with 91 prefix (no plus)', () => {
      expect(maskPhoneForExternal('919876543210')).toBe('******3210');
    });

    it('returns empty string for null', () => {
      expect(maskPhoneForExternal(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(maskPhoneForExternal(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(maskPhoneForExternal('')).toBe('');
    });

    it('returns **** for very short numbers', () => {
      expect(maskPhoneForExternal('12')).toBe('****');
    });

    it('handles number with spaces/dashes', () => {
      expect(maskPhoneForExternal('987-654-3210')).toBe('******3210');
    });
  });

  describe('maskPhoneForLog', () => {
    it('delegates to maskPhoneForExternal', () => {
      expect(maskPhoneForLog('9876543210')).toBe(maskPhoneForExternal('9876543210'));
    });
  });
});
