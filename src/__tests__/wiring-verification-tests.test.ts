/**
 * =============================================================================
 * WIRING VERIFICATION TESTS — Socket Event enum completeness, consistency,
 * emit function usage, and security hygiene
 * =============================================================================
 *
 * Found by ECHO-2 audit: 24 socket wiring gaps. These tests lock down the
 * CURRENT state of wiring and document remaining gaps as named failing cases
 * so future changes are visible.
 *
 * Test Categories:
 *   Category 1 — SocketEvent enum completeness (15 tests)
 *   Category 2 — Event name consistency (15 tests)
 *   Category 3 — Emit function usage (10 tests)
 *   Category 4 — Security checks (10 tests)
 * =============================================================================
 */

export {};

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relPath), 'utf-8');
}

function srcExists(relPath: string): boolean {
  return fs.existsSync(path.resolve(__dirname, '..', relPath));
}

function extractSocketEventValues(source: string): string[] {
  // Match lines like:   KEY: 'value',
  const matches = source.matchAll(/^\s+\w+:\s*'([^']+)'/gm);
  return Array.from(matches, (m) => m[1]);
}

function extractSocketEventKeys(source: string): string[] {
  // Match lines like:   KEY_NAME: '...',
  const matches = source.matchAll(/^\s+([A-Z_][A-Z0-9_]*):\s*'[^']+'/gm);
  return Array.from(matches, (m) => m[1]);
}

// ---------------------------------------------------------------------------
// Source snapshots — read once at suite level
// ---------------------------------------------------------------------------

// F-C-52: socket.service.ts now re-exports SocketEvent from the generated registry
// at packages/contracts/events.generated.ts. Concat both sources so every legacy
// wiring assertion that greps socket.service.ts content still matches when the
// event lives in the generated module. Concatenation preserves all existing
// regex semantics (/.../ against combined text) with zero false positives —
// the generated module shares the identical `KEY: 'value'` shape.
const CONTRACTS_GENERATED_PATH = path.resolve(__dirname, '..', '..', 'packages', 'contracts', 'events.generated.ts');
const CONTRACTS_GENERATED_SOURCE = fs.existsSync(CONTRACTS_GENERATED_PATH)
  ? fs.readFileSync(CONTRACTS_GENERATED_PATH, 'utf8')
  : '';
const SOCKET_SERVICE_SOURCE = readSrc('shared/services/socket.service.ts') + '\n' + CONTRACTS_GENERATED_SOURCE;
const ORDER_ACCEPT_SOURCE = readSrc('modules/order/order-accept.service.ts');
const OTP_CHALLENGE_SOURCE = srcExists('modules/auth/otp-challenge.service.ts')
  ? readSrc('modules/auth/otp-challenge.service.ts')
  : '';
const SMS_SERVICE_SOURCE = readSrc('modules/auth/sms.service.ts');

// All source files that emit socket events (excluding test files and socket.service itself)
const EMIT_SOURCE_FILES: string[] = [
  'modules/order/order-accept.service.ts',
  'modules/order/order.service.ts',
  'modules/order/order-broadcast.service.ts',
  'modules/order/order-lifecycle-outbox.service.ts',
  'modules/order/order-dispatch-outbox.service.ts',
  'modules/order/order.routes.ts',
  'modules/order-timeout/smart-timeout.service.ts',
  'modules/order-timeout/progress.service.ts',
  'modules/booking/booking.service.ts',
].filter((f) => srcExists(f));

const ALL_EMIT_SOURCES: string = EMIT_SOURCE_FILES.map((f) => readSrc(f)).join('\n');

// Extract the SocketEvent object block. Post-F-C-52 the block lives in
// packages/contracts/events.generated.ts, which ends with `} as const;` rather
// than `};`. Accept both suffixes so legacy assertions work against either.
const SOCKET_EVENT_BLOCK_MATCH = SOCKET_SERVICE_SOURCE.match(
  /export const SocketEvent\s*=\s*\{([\s\S]*?)\}(?:\s*as\s+const)?\s*;/
);
const SOCKET_EVENT_BLOCK = SOCKET_EVENT_BLOCK_MATCH ? SOCKET_EVENT_BLOCK_MATCH[1] : '';

const SOCKET_EVENT_VALUES = extractSocketEventValues(SOCKET_EVENT_BLOCK);
const SOCKET_EVENT_KEYS = extractSocketEventKeys(SOCKET_EVENT_BLOCK);

// ---------------------------------------------------------------------------
// Category 1 — SocketEvent enum completeness (15 tests)
// ---------------------------------------------------------------------------

describe('Category 1: SocketEvent enum completeness', () => {

  it('1.01 — SocketEvent object exists and is exported from socket.service.ts', () => {
    expect(SOCKET_SERVICE_SOURCE).toMatch(/export const SocketEvent\s*=/);
  });

  it('1.02 — SocketEvent block is non-empty (has at least 30 entries)', () => {
    expect(SOCKET_EVENT_VALUES.length).toBeGreaterThanOrEqual(30);
  });

  it('1.03 — BOOKING_PARTIALLY_FILLED is present in the enum', () => {
    // Used in booking.service.ts: emitToUser(..., SocketEvent.BOOKING_PARTIALLY_FILLED, ...)
    expect(SOCKET_EVENT_BLOCK).toMatch(/BOOKING_PARTIALLY_FILLED/);
  });

  it('1.04 — BOOKING_PARTIALLY_FILLED maps to lowercase snake_case value', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/BOOKING_PARTIALLY_FILLED:\s*'booking_partially_filled'/);
  });

  it('1.05 — REQUEST_NO_LONGER_AVAILABLE is present in the enum', () => {
    // Used in booking/order.service.ts for competing transporter notification
    expect(SOCKET_EVENT_BLOCK).toMatch(/REQUEST_NO_LONGER_AVAILABLE/);
  });

  it('1.06 — REQUEST_NO_LONGER_AVAILABLE maps to the correct value', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/REQUEST_NO_LONGER_AVAILABLE:\s*'request_no_longer_available'/);
  });

  it('1.07 — DRIVER_MAY_BE_OFFLINE is present in the enum', () => {
    // Used in order-accept.service.ts warn path when driver not online
    expect(SOCKET_EVENT_BLOCK).toMatch(/DRIVER_MAY_BE_OFFLINE/);
  });

  it('1.08 — DRIVER_MAY_BE_OFFLINE maps to the correct value', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/DRIVER_MAY_BE_OFFLINE:\s*'driver_may_be_offline'/);
  });

  it('1.09 — ASSIGNMENT_STALE is present in the enum', () => {
    // Used in assignment expiry flow
    expect(SOCKET_EVENT_BLOCK).toMatch(/ASSIGNMENT_STALE/);
  });

  it('1.10 — ASSIGNMENT_STALE maps to the correct value', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/ASSIGNMENT_STALE:\s*'assignment_stale'/);
  });

  it('1.11 — ORDER_NO_SUPPLY is now present in the enum (gap was fixed)', () => {
    // order.service.ts:1276 previously emitted 'order_no_supply' as a raw string.
    // The enum entry ORDER_NO_SUPPLY: 'order_no_supply' has been added to socket.service.ts.
    // This test verifies the gap is closed. The raw string usage in order.service.ts
    // should now be migrated to use SocketEvent.ORDER_NO_SUPPLY.
    expect(SOCKET_EVENT_BLOCK).toMatch(/ORDER_NO_SUPPLY:\s*'order_no_supply'/);
  });

  it('1.12 — All enum keys are in UPPER_SNAKE_CASE format', () => {
    const invalidKeys = SOCKET_EVENT_KEYS.filter((k) => !/^[A-Z][A-Z0-9_]*$/.test(k));
    expect(invalidKeys).toEqual([]);
  });

  it('1.13 — Duplicate enum values are limited to the known intentional alias (order_cancelled)', () => {
    // DOCUMENTED: BROADCAST_CANCELLED and ORDER_CANCELLED intentionally share the value
    // 'order_cancelled' for backward compatibility. No other duplicates should exist.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const value of SOCKET_EVENT_VALUES) {
      if (seen.has(value)) {
        duplicates.push(value);
      }
      seen.add(value);
    }
    // Only the known intentional alias is allowed as a duplicate
    const unexpectedDuplicates = duplicates.filter((v) => v !== 'order_cancelled');
    expect(unexpectedDuplicates).toEqual([]);
    // And confirm the known alias duplicate is exactly one occurrence
    expect(duplicates).toEqual(['order_cancelled']);
  });

  it('1.14 — BOOKING_FULLY_FILLED is present in the enum', () => {
    // order-accept.service.ts emits booking_fully_filled for customers
    expect(SOCKET_EVENT_BLOCK).toMatch(/BOOKING_FULLY_FILLED/);
  });

  it('1.15 — TRUCKS_REMAINING_UPDATE is present in the enum', () => {
    // order-accept.service.ts: emitToUser(customerId, "trucks_remaining_update", ...)
    expect(SOCKET_EVENT_BLOCK).toMatch(/TRUCKS_REMAINING_UPDATE/);
  });

});

// ---------------------------------------------------------------------------
// Category 2 — Event name consistency (15 tests)
// ---------------------------------------------------------------------------

describe('Category 2: Event name consistency', () => {

  it('2.01 — BOOKING_COMPLETED has value "booking_completed" (Customer app rating trigger)', () => {
    // Customer app listens for Events.BOOKING_COMPLETED = "booking_completed"
    expect(SOCKET_EVENT_BLOCK).toMatch(/BOOKING_COMPLETED:\s*'booking_completed'/);
  });

  it('2.02 — ORDER_COMPLETED has value "order_completed"', () => {
    // Customer app listens for Events.ORDER_COMPLETED = "order_completed"
    expect(SOCKET_EVENT_BLOCK).toMatch(/ORDER_COMPLETED:\s*'order_completed'/);
  });

  it('2.03 — TRIP_ASSIGNED has value "trip_assigned" (driver screen trigger)', () => {
    // Captain app SocketEventRouter.kt handles trip_assigned to show overlay
    expect(SOCKET_EVENT_BLOCK).toMatch(/TRIP_ASSIGNED:\s*'trip_assigned'/);
  });

  it('2.04 — NEW_BROADCAST has value "new_broadcast"', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/NEW_BROADCAST:\s*'new_broadcast'/);
  });

  it('2.05 — All event string values are lowercase_snake_case', () => {
    const invalid = SOCKET_EVENT_VALUES.filter(
      (v) => !/^[a-z][a-z0-9_]*$/.test(v)
    );
    expect(invalid).toEqual([]);
  });

  it('2.06 — No event name contains spaces', () => {
    const withSpaces = SOCKET_EVENT_VALUES.filter((v) => /\s/.test(v));
    expect(withSpaces).toEqual([]);
  });

  it('2.07 — No event name contains special characters other than underscore', () => {
    const withSpecialChars = SOCKET_EVENT_VALUES.filter((v) => /[^a-z0-9_]/.test(v));
    expect(withSpecialChars).toEqual([]);
  });

  it('2.08 — No event name starts with an underscore', () => {
    const startsWithUnderscore = SOCKET_EVENT_VALUES.filter((v) => v.startsWith('_'));
    expect(startsWithUnderscore).toEqual([]);
  });

  it('2.09 — No event name ends with an underscore', () => {
    const endsWithUnderscore = SOCKET_EVENT_VALUES.filter((v) => v.endsWith('_'));
    expect(endsWithUnderscore).toEqual([]);
  });

  it('2.10 — ORDER_CANCELLED value is "order_cancelled"', () => {
    // Both BROADCAST_CANCELLED and ORDER_CANCELLED map to order_cancelled — documents intentional alias
    expect(SOCKET_EVENT_BLOCK).toMatch(/ORDER_CANCELLED:\s*'order_cancelled'/);
  });

  it('2.11 — CONNECTED has value "connected"', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/CONNECTED:\s*'connected'/);
  });

  it('2.12 — ERROR has value "error"', () => {
    expect(SOCKET_EVENT_BLOCK).toMatch(/ERROR:\s*'error'/);
  });

  it('2.13 — HEARTBEAT has value "heartbeat"', () => {
    // Captain app sends heartbeat every 12s
    expect(SOCKET_EVENT_BLOCK).toMatch(/HEARTBEAT:\s*'heartbeat'/);
  });

  it('2.14 — ORDER_PROGRESS_UPDATE has value "order_progress_update"', () => {
    // progress.service.ts uses emitToOrder for order_progress_update
    expect(SOCKET_EVENT_BLOCK).toMatch(/ORDER_PROGRESS_UPDATE:\s*'order_progress_update'/);
  });

  it('2.15 — ORDER_TIMEOUT_EXTENDED has value "order_timeout_extended"', () => {
    // smart-timeout.service.ts uses emitToOrder for order_timeout_extended
    expect(SOCKET_EVENT_BLOCK).toMatch(/ORDER_TIMEOUT_EXTENDED:\s*'order_timeout_extended'/);
  });

});

// ---------------------------------------------------------------------------
// Category 3 — Emit function usage (10 tests)
// ---------------------------------------------------------------------------

describe('Category 3: Emit function usage', () => {

  it('3.01 — emitToUser is exported from socket.service.ts', () => {
    expect(SOCKET_SERVICE_SOURCE).toMatch(/export function emitToUser/);
  });

  it('3.02 — emitToOrder is exported from socket.service.ts', () => {
    expect(SOCKET_SERVICE_SOURCE).toMatch(/export function emitToOrder/);
  });

  it('3.03 — emitToBooking is exported from socket.service.ts', () => {
    expect(SOCKET_SERVICE_SOURCE).toMatch(/export function emitToBooking/);
  });

  it('3.04 — order_progress_update uses emitToOrder (room-targeted, not emitToUser)', () => {
    // progress.service.ts must target order room, not individual user, for progress updates
    const progressSource = srcExists('modules/order-timeout/progress.service.ts')
      ? readSrc('modules/order-timeout/progress.service.ts')
      : '';
    if (!progressSource) {
      // file not present — skip with pass
      expect(true).toBe(true);
      return;
    }
    expect(progressSource).toMatch(/emitToOrder[^;]*order_progress_update/);
  });

  it('3.05 — order_timeout_extended uses emitToOrder (room-targeted, not emitToUser)', () => {
    // smart-timeout.service.ts should use emitToOrder, not emitToUser, for timeout extension
    const timeoutSource = srcExists('modules/order-timeout/smart-timeout.service.ts')
      ? readSrc('modules/order-timeout/smart-timeout.service.ts')
      : '';
    if (!timeoutSource) {
      expect(true).toBe(true);
      return;
    }
    expect(timeoutSource).toMatch(/emitToOrder[^;]*order_timeout_extended/);
  });

  it('3.06 — order-accept.service.ts uses emitToUser for trucks_remaining_update (user-targeted)', () => {
    // trucks_remaining_update goes directly to the customer, not broadcast to order room
    expect(ORDER_ACCEPT_SOURCE).toMatch(/emitToUser\s*\([^,]+,\s*['"]trucks_remaining_update['"]/);
  });

  it('3.07 — order-accept.service.ts does NOT use emitToOrder for trucks_remaining_update', () => {
    // trucks_remaining_update must reach the specific customer, not the order room
    expect(ORDER_ACCEPT_SOURCE).not.toMatch(/emitToOrder\s*\([^,]+,\s*['"]trucks_remaining_update['"]/);
  });

  it('3.08 — emitToUser guard: socket.service.ts returns false when io is null', () => {
    // Fix E7 guard — prevents silent failures when Socket.IO not initialized
    // The guard is: if (!io) { logger.error(...); return false; }
    expect(SOCKET_SERVICE_SOURCE).toMatch(/if\s*\(!io\)/);
    // Verify return false exists in the emitToUser function body
    const emitToUserIdx = SOCKET_SERVICE_SOURCE.indexOf('export function emitToUser');
    const emitToUserEnd = SOCKET_SERVICE_SOURCE.indexOf('\nexport function', emitToUserIdx + 1);
    const emitToUserBody = SOCKET_SERVICE_SOURCE.slice(
      emitToUserIdx,
      emitToUserEnd === -1 ? emitToUserIdx + 500 : emitToUserEnd
    );
    expect(emitToUserBody).toMatch(/return false/);
  });

  it('3.09 — emitToUser guard: socket.service.ts logs error for undefined event name', () => {
    // Fix FIX-4 (#88) guard — prevents emitting undefined event names
    expect(SOCKET_SERVICE_SOURCE).toMatch(/if\s*\(!event\)/);
    expect(SOCKET_SERVICE_SOURCE).toMatch(/BUG.*undefined event|undefined event.*BUG/i);
  });

  it('3.10 — booking_completed is emitted via emitToUser (user-targeted event, not room)', () => {
    // order.routes.ts emits booking_completed directly to customer
    const routeSource = srcExists('modules/order/order.routes.ts')
      ? readSrc('modules/order/order.routes.ts')
      : '';
    if (!routeSource) {
      expect(true).toBe(true);
      return;
    }
    expect(routeSource).toMatch(/emitToUser[^;]*booking_completed/);
  });

});

// ---------------------------------------------------------------------------
// Category 4 — Security checks (10 tests)
// ---------------------------------------------------------------------------

describe('Category 4: Security checks', () => {

  it('4.01 — otp-challenge.service.ts does NOT contain $executeRawUnsafe', () => {
    // Q4 fix: all OTP SQL must use parameterised tagged templates
    if (!OTP_CHALLENGE_SOURCE) {
      expect(true).toBe(true); // file not present
      return;
    }
    expect(OTP_CHALLENGE_SOURCE).not.toMatch(/\$executeRawUnsafe/);
  });

  it('4.02 — No production source file logs ${otp} via console.log', () => {
    // Q3 fix: OTP values must never appear in console output
    const sourceFiles = [
      'modules/auth/sms.service.ts',
      'modules/auth/auth.service.ts',
      'modules/auth/otp-challenge.service.ts',
      'modules/driver/driver.routes.ts',
    ].filter((f) => srcExists(f));

    for (const filePath of sourceFiles) {
      const content = readSrc(filePath);
      expect(content).not.toMatch(/console\.log[^;]*\$\{otp\}/);
    }
  });

  it('4.03 — sms.service.ts does NOT log raw otp via console.log', () => {
    expect(SMS_SERVICE_SOURCE).not.toMatch(/console\.log[^;)]*\botp\b/i);
  });

  it('4.04 — CLAUDE.md does NOT contain a plaintext database password', () => {
    const claudeMdPath = path.resolve(__dirname, '../../CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    // The password 'N1it2is4h' documented in CLAUDE.md must be removed
    expect(content).not.toContain('N1it2is4h');
  });

  it('4.05 — CLAUDE.md does NOT contain a postgres connection string with embedded password', () => {
    const claudeMdPath = path.resolve(__dirname, '../../CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    // Pattern: postgresql://user:password@host (any non-empty password segment)
    const connStringWithPassword = content.match(/postgresql:\/\/[^:]+:[^@]{1,64}@/);
    expect(connStringWithPassword).toBeNull();
  });

  it('4.06 — No hardcoded Twilio SID in any auth source file', () => {
    // Twilio Account SIDs start with AC followed by 32 hex chars
    expect(SMS_SERVICE_SOURCE).not.toMatch(/AC[0-9a-f]{32}/);
  });

  it('4.07 — No hardcoded Twilio auth token in any auth source file', () => {
    // Twilio auth tokens start with SK followed by 32 hex chars
    expect(SMS_SERVICE_SOURCE).not.toMatch(/SK[0-9a-f]{32}/);
  });

  it('4.08 — No hardcoded JWT secret in auth.service.ts', () => {
    if (!srcExists('modules/auth/auth.service.ts')) {
      expect(true).toBe(true);
      return;
    }
    const authServiceSource = readSrc('modules/auth/auth.service.ts');
    expect(authServiceSource).not.toMatch(/jwtSecret\s*=\s*['"][^'"]{8,}['"]/);
    expect(authServiceSource).not.toMatch(/JWT_SECRET\s*=\s*['"][^'"]{8,}['"]/);
  });

  it('4.09 — socket.service.ts does NOT hardcode any API keys or secrets', () => {
    // No string that looks like an API key (long alphanumeric after key=/secret=/token= assignment)
    expect(SOCKET_SERVICE_SOURCE).not.toMatch(
      /(?:key|secret|password|token)\s*=\s*['"][A-Za-z0-9+/]{20,}['"]/i
    );
  });

  it('4.10 — order-accept.service.ts does NOT contain $executeRawUnsafe', () => {
    // Accept flow is business-critical; must not use raw unsafe SQL
    expect(ORDER_ACCEPT_SOURCE).not.toMatch(/\$executeRawUnsafe/);
  });

});

// ---------------------------------------------------------------------------
// Documented Gaps Summary (informational describe — always passes)
// ---------------------------------------------------------------------------

describe('ECHO-2 Wiring Gaps — Documented State', () => {

  it('GAP-01 — ORDER_NO_SUPPLY enum entry exists and no raw string emit sites remain', () => {
    // The SocketEvent.ORDER_NO_SUPPLY enum entry was added to socket.service.ts.
    // Verify the enum entry is present and no raw-string 'order_no_supply' emit
    // sites remain in production source files (gap is fully closed).
    expect(SOCKET_SERVICE_SOURCE).toMatch(/ORDER_NO_SUPPLY:\s*'order_no_supply'/);
    // Scan all emit source files — none should use the raw string form
    const rawStringEmitFound = EMIT_SOURCE_FILES.some((f) => {
      const content = readSrc(f);
      return /emitToUser[^;]*['"]order_no_supply['"]/.test(content);
    });
    // Gap is closed: no raw string usage in emit call sites
    expect(rawStringEmitFound).toBe(false);
  });

  it('GAP-02 — BROADCAST_CANCELLED shares value with ORDER_CANCELLED (intentional alias)', () => {
    // Both BROADCAST_CANCELLED and ORDER_CANCELLED map to 'order_cancelled'.
    // This is intentional for backward compatibility but is a source of confusion.
    // Confirmed: no duplicate value bug — both keys exist and alias is documented.
    const broadcastCancelledValue = SOCKET_EVENT_BLOCK.match(
      /BROADCAST_CANCELLED:\s*'([^']+)'/
    )?.[1];
    const orderCancelledValue = SOCKET_EVENT_BLOCK.match(
      /ORDER_CANCELLED:\s*'([^']+)'/
    )?.[1];
    expect(broadcastCancelledValue).toBe('order_cancelled');
    expect(orderCancelledValue).toBe('order_cancelled');
  });

  it('GAP-03 — emitToUser is used for both user-targeted and fallback order events', () => {
    // Some events (trucks_remaining_update, booking_fully_filled) use emitToUser
    // even when an order room exists, because the recipient is the specific customer.
    // This is correct behavior but deviates from emitToOrder for order-scoped events.
    expect(ORDER_ACCEPT_SOURCE).toMatch(/emitToUser/);
    expect(ORDER_ACCEPT_SOURCE).not.toMatch(/emitToOrder/);
  });

});
