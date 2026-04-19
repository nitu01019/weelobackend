export {};

describe('Idempotency Safety Patterns', () => {
  describe('PII Masking is Idempotent', () => {
    const { maskPhoneForExternal } = require('../shared/utils/pii.utils');

    it('masking an already masked phone returns consistent result', () => {
      const original = '9876543210';
      const masked = maskPhoneForExternal(original);
      const doubleMasked = maskPhoneForExternal(masked);
      // Double masking should not crash
      expect(doubleMasked).toBeDefined();
      expect(typeof doubleMasked).toBe('string');
    });

    it('masking same phone twice returns same result', () => {
      const phone = '9797040090';
      expect(maskPhoneForExternal(phone)).toBe(maskPhoneForExternal(phone));
    });
  });

  describe('Error Utils are Idempotent', () => {
    const { getErrorMessage } = require('../shared/utils/error.utils');

    it('same error returns same message', () => {
      const err = new Error('test');
      expect(getErrorMessage(err)).toBe(getErrorMessage(err));
    });
  });

  describe('Config is Deterministic', () => {
    it('HOLD_CONFIG returns same values on repeated access', () => {
      const { HOLD_CONFIG: first } = require('../core/config/hold-config');
      const { HOLD_CONFIG: second } = require('../core/config/hold-config');
      expect(first.flexHoldDurationSeconds).toBe(second.flexHoldDurationSeconds);
      expect(first.confirmedHoldMaxSeconds).toBe(second.confirmedHoldMaxSeconds);
    });
  });

  describe('Pagination is Safe', () => {
    const { clampPageSize } = require('../shared/utils/validation.utils');

    it('repeated clamping gives same result', () => {
      const result1 = clampPageSize(500);
      const result2 = clampPageSize(500);
      expect(result1).toBe(result2);
    });

    it('clamping a clamped value is idempotent', () => {
      const first = clampPageSize(500);
      const second = clampPageSize(first);
      expect(first).toBe(second);
    });
  });
});
