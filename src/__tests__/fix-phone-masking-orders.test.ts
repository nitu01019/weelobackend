/**
 * FIX-5 (#120): Customer phone number masking across ORDER module files.
 *
 * Validates that all order module files importing maskPhoneForExternal
 * correctly mask customerPhone before sending it to transporters/drivers.
 * This prevents PII exposure (India DPDPA 2023 compliance).
 */

import * as fs from 'fs';
import * as path from 'path';
import { maskPhoneForExternal } from '../shared/utils/pii.utils';

// ---------------------------------------------------------------------------
// Helper: read file content relative to src/
// ---------------------------------------------------------------------------
function readSrcFile(relativePath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '..', relativePath),
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// 1. maskPhoneForExternal handles null / undefined / edge cases gracefully
// ---------------------------------------------------------------------------
describe('maskPhoneForExternal graceful handling', () => {
  it('returns empty string for null', () => {
    expect(maskPhoneForExternal(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(maskPhoneForExternal(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(maskPhoneForExternal('')).toBe('');
  });

  it('returns **** for very short numbers (< 4 digits)', () => {
    expect(maskPhoneForExternal('12')).toBe('****');
    expect(maskPhoneForExternal('1')).toBe('****');
    expect(maskPhoneForExternal('123')).toBe('****');
  });

  it('masks standard 10-digit phone', () => {
    expect(maskPhoneForExternal('9876543210')).toBe('******3210');
  });

  it('masks phone with +91 prefix', () => {
    expect(maskPhoneForExternal('+919876543210')).toBe('******3210');
  });

  it('does not return the raw phone number', () => {
    const raw = '9876543210';
    const masked = maskPhoneForExternal(raw);
    expect(masked).not.toBe(raw);
    expect(masked).not.toContain('98765');
  });
});

// ---------------------------------------------------------------------------
// 2. Each target file has the maskPhoneForExternal import
// ---------------------------------------------------------------------------
describe('maskPhoneForExternal import present in order module files', () => {
  const files = [
    'modules/order/order-accept.service.ts',
    'modules/order/order.routes.ts',
    'modules/order/order-broadcast.service.ts',
    'modules/order/order-cancel.service.ts',
    'modules/order/order-lifecycle-outbox.service.ts',
    'modules/order/order-dispatch-outbox.service.ts',
  ];

  for (const file of files) {
    it(`${file} imports maskPhoneForExternal`, () => {
      const content = readSrcFile(file);
      expect(content).toContain("import { maskPhoneForExternal } from '../../shared/utils/pii.utils'");
    });
  }
});

// ---------------------------------------------------------------------------
// 3. No raw customerPhone assignments remain (all go through masking)
// ---------------------------------------------------------------------------
describe('customerPhone values are masked (not raw) in order module files', () => {
  /**
   * Pattern: detects lines like `customerPhone: order.customerPhone` or
   * `customerPhone: refreshedOrder.customerPhone` that are NOT wrapped
   * in maskPhoneForExternal(...).
   *
   * Allowed patterns:
   *   customerPhone: maskPhoneForExternal(...)
   *   customerPhone: orderCustomerPhone  (already masked upstream)
   *   customerPhone?: string             (type definition)
   *   customerPhone: string              (type definition)
   *   payload.customerPhone              (function parameter access, not assignment)
   *   row.customerPhone                  (inside maskPhoneForExternal call)
   *   driver.customerPhone               (inside maskPhoneForExternal call)
   */

  const targetFiles = [
    'modules/order/order-accept.service.ts',
    'modules/order/order.routes.ts',
    'modules/order/order-broadcast.service.ts',
    'modules/order/order-cancel.service.ts',
    'modules/order/order-lifecycle-outbox.service.ts',
    'modules/order/order-dispatch-outbox.service.ts',
  ];

  for (const file of targetFiles) {
    it(`${file} has no raw customerPhone in outgoing payloads`, () => {
      const content = readSrcFile(file);
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip comments
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

        // Skip type definitions and interface fields
        if (/customerPhone\??\s*:\s*string/.test(line)) continue;

        // Skip import lines
        if (line.startsWith('import ')) continue;

        // Skip lines that are purely accessing a parameter (not assigning to a payload)
        // e.g., `payload.customerPhone`, `row.customerPhone` inside a ternary/function arg
        if (/typeof\s+\w+\.customerPhone/.test(line)) continue;

        // Detect: `customerPhone: <something>.customerPhone` NOT wrapped in maskPhoneForExternal
        // This is the dangerous pattern we want to eliminate.
        const assignmentMatch = line.match(/customerPhone\s*:\s*(?!maskPhoneForExternal)/);
        if (assignmentMatch) {
          // Allow: `customerPhone: orderCustomerPhone` (already masked upstream in order-accept)
          if (/customerPhone\s*:\s*orderCustomerPhone/.test(line)) continue;

          // Allow: `customerPhone: typeof row...` ternary with maskPhoneForExternal
          if (/maskPhoneForExternal/.test(line)) continue;

          // This line has an unmasked customerPhone assignment
          fail(
            `${file}:${i + 1} has unmasked customerPhone: "${line.trim()}"`
          );
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Reference file (order-broadcast.service.ts) still has masking
// ---------------------------------------------------------------------------
describe('reference implementation still correct', () => {
  it('order-broadcast.service.ts masks customerPhone', () => {
    const content = readSrcFile('modules/order/order-broadcast.service.ts');
    expect(content).toContain("import { maskPhoneForExternal } from '../../shared/utils/pii.utils'");
    expect(content).toContain('maskPhoneForExternal(payload.customerPhone');
  });
});
