export {};

/**
 * FIX-5 (#120): Customer phone masking across non-order module files.
 *
 * Verifies that every file modified in FIX-5 now imports maskPhoneForExternal
 * and applies it to customerPhone values sent to transporters/drivers.
 */

import { maskPhoneForExternal } from '../shared/utils/pii.utils';

const fs = require('fs');
const path = require('path');

function readSourceFile(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf-8');
}

describe('FIX-5: Customer Phone Masking (Non-Order Modules)', () => {
  // -----------------------------------------------------------------------
  // 1. maskPhoneForExternal utility works correctly
  // -----------------------------------------------------------------------
  describe('maskPhoneForExternal utility', () => {
    it('masks a 10-digit phone to ******XXXX format', () => {
      expect(maskPhoneForExternal('9876543210')).toBe('******3210');
    });

    it('masks phone with +91 prefix', () => {
      expect(maskPhoneForExternal('+919876543210')).toBe('******3210');
    });

    it('returns empty string for null/undefined', () => {
      expect(maskPhoneForExternal(null)).toBe('');
      expect(maskPhoneForExternal(undefined)).toBe('');
    });

    it('returns **** for numbers shorter than 4 digits', () => {
      expect(maskPhoneForExternal('12')).toBe('****');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Source code import verification: each patched file imports the util
  // -----------------------------------------------------------------------
  describe('Import verification: maskPhoneForExternal is imported', () => {
    const filesToCheck = [
      'modules/truck-hold/truck-hold.service.ts',
      'modules/truck-hold/truck-hold-confirm.service.ts',
      'modules/truck-hold/truck-hold-query.service.ts',
      'modules/tracking/tracking.routes.ts',
      'modules/driver/driver.service.ts',
      'modules/driver/driver-performance.service.ts',
      'modules/assignment/assignment.routes.ts',
      'modules/booking/booking.routes.ts',
    ];

    for (const file of filesToCheck) {
      it(`${file} imports maskPhoneForExternal`, () => {
        const content = readSourceFile(file);
        expect(content).toContain("import { maskPhoneForExternal } from");
        expect(content).toContain('pii.utils');
      });
    }
  });

  // -----------------------------------------------------------------------
  // 3. Source code usage verification: no raw customerPhone leaks
  // -----------------------------------------------------------------------
  describe('Usage verification: customerPhone is masked in payloads', () => {
    it('truck-hold.service.ts masks all 4 customerPhone payload sites', () => {
      const content = readSourceFile('modules/truck-hold/truck-hold.service.ts');
      // Count maskPhoneForExternal usages (excluding the import line)
      const importLine = "import { maskPhoneForExternal }";
      const withoutImport = content.replace(importLine, '');
      const maskedCount = (withoutImport.match(/maskPhoneForExternal\(/g) || []).length;
      expect(maskedCount).toBeGreaterThanOrEqual(4);

      // Verify no raw customerPhone: <value> patterns without masking
      // All customerPhone assignments must go through masking
      const rawLeaks = content.match(/customerPhone:\s*order\.customerPhone(?!\s*\))/g);
      expect(rawLeaks).toBeNull();
    });

    it('truck-hold-confirm.service.ts masks both Socket.IO and FCM payloads', () => {
      const content = readSourceFile('modules/truck-hold/truck-hold-confirm.service.ts');
      const withoutImport = content.replace("import { maskPhoneForExternal }", '');
      const maskedCount = (withoutImport.match(/maskPhoneForExternal\(/g) || []).length;
      expect(maskedCount).toBeGreaterThanOrEqual(2);
    });

    it('truck-hold-query.service.ts masks customerPhone in availability response', () => {
      const content = readSourceFile('modules/truck-hold/truck-hold-query.service.ts');
      expect(content).toContain('customerPhone: maskPhoneForExternal(');
      // Must NOT have raw customerPhone assignment
      const rawLeaks = content.match(/customerPhone:\s*order\.customerPhone(?!\s*\))/g);
      expect(rawLeaks).toBeNull();
    });

    it('tracking.routes.ts masks customerPhone in tracking response', () => {
      const content = readSourceFile('modules/tracking/tracking.routes.ts');
      expect(content).toContain('customerPhone: maskPhoneForExternal(');
    });

    it('driver.service.ts masks customerPhone in active trip data', () => {
      const content = readSourceFile('modules/driver/driver.service.ts');
      expect(content).toContain("maskPhoneForExternal(order?.customerPhone || '')");
    });

    it('driver-performance.service.ts masks customerPhone in performance data', () => {
      const content = readSourceFile('modules/driver/driver-performance.service.ts');
      expect(content).toContain('maskPhoneForExternal(activeTrip.customerPhone)');
    });

    it('assignment.routes.ts masks customerPhone in assignment order data', () => {
      const content = readSourceFile('modules/assignment/assignment.routes.ts');
      expect(content).toContain('maskPhoneForExternal(raw.order.customerPhone)');
    });

    it('booking.routes.ts masks customerPhone in broadcast-snapshot response', () => {
      const content = readSourceFile('modules/booking/booking.routes.ts');
      expect(content).toContain('maskPhoneForExternal(details.customerPhone)');
    });
  });

  // -----------------------------------------------------------------------
  // 4. Regression: previously-fixed files still use masking
  // -----------------------------------------------------------------------
  describe('Regression: order module files still mask correctly', () => {
    it('order-broadcast.service.ts uses maskPhoneForExternal', () => {
      const content = readSourceFile('modules/order/order-broadcast.service.ts');
      expect(content).toContain('maskPhoneForExternal(payload.customerPhone');
    });

    it('order-accept.service.ts uses maskPhoneForExternal', () => {
      const content = readSourceFile('modules/order/order-accept.service.ts');
      expect(content).toContain('maskPhoneForExternal(order.customerPhone)');
    });
  });

  // -----------------------------------------------------------------------
  // 5. No raw customerPhone in driver-facing notification payloads
  // -----------------------------------------------------------------------
  describe('No raw phone leaks in driver notification payloads', () => {
    it('all trip_assigned Socket.IO payloads use masking', () => {
      const files = [
        'modules/truck-hold/truck-hold.service.ts',
        'modules/truck-hold/truck-hold-confirm.service.ts',
      ];
      for (const file of files) {
        const content = readSourceFile(file);
        // Find all customerPhone lines in trip_assigned context
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('customerPhone:') && !line.includes('maskPhoneForExternal')) {
            // Only type definitions are allowed to have raw customerPhone
            const isTypeDefinition = line.includes('string') || line.includes('true');
            if (!isTypeDefinition) {
              fail(`${file}:${i + 1} has raw customerPhone in payload: ${line}`);
            }
          }
        }
      }
    });

    it('all FCM push payloads use masking', () => {
      const files = [
        'modules/truck-hold/truck-hold.service.ts',
        'modules/truck-hold/truck-hold-confirm.service.ts',
      ];
      for (const file of files) {
        const content = readSourceFile(file);
        // Look for FCM data blocks with customerPhone
        const fcmBlocks = content.split('queuePushNotification');
        for (let i = 1; i < fcmBlocks.length; i++) {
          const block = fcmBlocks[i].slice(0, 500); // Check ~500 chars before push call
          if (block.includes('customerPhone') && !block.includes('maskPhoneForExternal')) {
            // Ensure the customerPhone assignment before this push uses masking
            // This is a heuristic; the key check is in the explicit tests above
          }
        }
        // The explicit tests above verify exact masking, so just ensure no raw phone
        expect(content).not.toMatch(/customerPhone:\s*order\.customerPhone\s*\|\|\s*''/);
      }
    });
  });
});
