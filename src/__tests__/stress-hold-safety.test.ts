export {};

describe('Hold System Safety', () => {
  describe('Hold Configuration', () => {
    it('HOLD_CONFIG has all required fields', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.flexHoldDurationSeconds).toBeDefined();
      expect(HOLD_CONFIG.flexHoldExtensionSeconds).toBeDefined();
      expect(HOLD_CONFIG.flexHoldMaxDurationSeconds).toBeDefined();
      expect(HOLD_CONFIG.flexHoldMaxExtensions).toBeDefined();
      expect(HOLD_CONFIG.confirmedHoldMaxSeconds).toBeDefined();
      expect(HOLD_CONFIG.driverAcceptTimeoutSeconds).toBeDefined();
      expect(HOLD_CONFIG.driverAcceptTimeoutMs).toBeDefined();
    });

    it('flex hold duration is 90 seconds', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.flexHoldDurationSeconds).toBe(90);
    });

    it('flex hold extension is 30 seconds', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.flexHoldExtensionSeconds).toBe(30);
    });

    it('flex hold max duration is 130 seconds', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.flexHoldMaxDurationSeconds).toBe(130);
    });

    it('max extensions is 2', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.flexHoldMaxExtensions).toBe(2);
    });

    it('confirmed hold max is 180 seconds', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.confirmedHoldMaxSeconds).toBe(180);
    });

    it('driver accept timeout is 45 seconds', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.driverAcceptTimeoutSeconds).toBe(45);
    });

    it('driver accept timeout ms is 45000', () => {
      const { HOLD_CONFIG } = require('../core/config/hold-config');
      expect(HOLD_CONFIG.driverAcceptTimeoutMs).toBe(45000);
    });
  });
});
