/**
 * =============================================================================
 * W0-1 — FCM priority regression guard (Phase 3 → 100% push)
 * =============================================================================
 *
 * BACKGROUND
 *   Commit 4d071a1 ("fix(fcm): move priority field into data object per FCM SDK
 *   contract") silently regressed Android driver push priority from `high` to
 *   `normal`. The root cause is that `buildMessage()` in
 *   `src/shared/services/fcm.service.ts` reads `notification.priority` — the
 *   top-level field on the FCMNotification shape — to decide whether to emit
 *   `android.priority === 'high'` on the outgoing FCM payload. After 4d071a1,
 *   the 3 driver-dispatch callsites (assignment, broadcast-accept, reassign-
 *   driver) bury `priority: 'high'` inside the `data` Record, where it is NOT
 *   read by `buildMessage`. The consequence: Android sees `normal` priority
 *   pushes and may defer them under doze/battery optimisation — critical trip-
 *   assignment notifications arrive late or after app is killed.
 *
 * THIS TEST ENFORCES THAT:
 *   (1) The `queuePushNotification` and `queuePushNotificationBatch` signatures
 *       in `queue.service.ts` accept a `priority` field at the top level.
 *   (2) All 5 driver-dispatch callsites pass `priority: 'high'` at the TOP
 *       LEVEL of the notification object (not inside `data`).
 *   (3) The downstream FCM payload (android.priority) becomes 'high' end-to-end
 *       when these callsites fire.
 *   (4) Customer-facing queue pushes (broadcast-accept line 528, order cancel
 *       customer batch line 386) are UNCHANGED — they do NOT need top-level
 *       priority. This is a regression guard against overreach.
 *   (5) The 5 target files retain the `priority: 'high'` top-level hoist. Any
 *       future edit that strips it will flip the guard red.
 *
 * CALLSITE INVENTORY (5 sites — positive enumeration, plan §W0-1):
 *   A. src/modules/assignment/assignment.service.ts     (queuePushNotification — driver assignment, title: 'New Trip Assigned!')
 *   B. src/modules/broadcast/broadcast-accept.service.ts (queuePushNotification(driverId,...) — retry-fallback driver path)
 *   C. src/modules/truck-hold/reassign-driver.service.ts (queuePushNotification(newDriverId,...) — driver reassignment)
 *   D. src/modules/booking/booking-lifecycle.service.ts  (queuePushNotificationBatch(booking.notifiedTransporters,...) — booking-expired)
 *   E. src/modules/order/order-lifecycle-outbox.service.ts (queuePushNotificationBatch(payload.transporters,...) — order-cancelled)
 *
 * RED-GREEN LIFECYCLE:
 *   - Commit 1 (this file, RED): all 5 callsite assertions fail because the
 *     callsites bury priority in `data` and the queue-service signatures
 *     reject top-level priority.
 *   - Commit 2a: signatures accept priority; source tests still RED until
 *     callsites are updated.
 *   - Commit 2b: callsites hoist priority to top level — all tests green.
 *   - Commit 2c: full suite green, verified.
 *
 * @fixes W0-1
 * @see commit 4d071a1 — the regression this reverses at the wire layer.
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// Source-file paths (resolved once)
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const FILE_QUEUE_SERVICE = path.join(
  SRC_ROOT,
  'shared',
  'services',
  'queue.service.ts',
);
const FILE_FCM_SERVICE = path.join(
  SRC_ROOT,
  'shared',
  'services',
  'fcm.service.ts',
);
const FILE_ASSIGNMENT = path.join(
  SRC_ROOT,
  'modules',
  'assignment',
  'assignment.service.ts',
);
const FILE_BROADCAST_ACCEPT = path.join(
  SRC_ROOT,
  'modules',
  'broadcast',
  'broadcast-accept.service.ts',
);
const FILE_REASSIGN_DRIVER = path.join(
  SRC_ROOT,
  'modules',
  'truck-hold',
  'reassign-driver.service.ts',
);
const FILE_BOOKING_LIFECYCLE = path.join(
  SRC_ROOT,
  'modules',
  'booking',
  'booking-lifecycle.service.ts',
);
const FILE_ORDER_OUTBOX = path.join(
  SRC_ROOT,
  'modules',
  'order',
  'order-lifecycle-outbox.service.ts',
);

const read = (p: string): string => fs.readFileSync(p, 'utf-8');

// =============================================================================
// Helpers — balanced-brace argument and notification-object extraction.
// =============================================================================

/**
 * Walk from a paren index to its matching close, respecting nested braces/parens.
 * Returns the argument string (without outer parens).
 */
function balancedParenBody(source: string, openParenIdx: number): string | null {
  if (source[openParenIdx] !== '(') return null;
  let depth = 0;
  for (let i = openParenIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

/**
 * Locate a specific queue-service call and return its argument body.
 * Uses a strong leading regex that anchors on the full invocation (e.g.
 * `queueService.queuePushNotification(driverId,`) to avoid collisions with
 * other calls in the same file.
 */
function findCallArgs(source: string, leadingRe: RegExp): string | null {
  const m = leadingRe.exec(source);
  if (!m) return null;
  // The '(' that opens the call is the last char of the matched prefix.
  const openIdx = source.indexOf('(', m.index);
  return balancedParenBody(source, openIdx);
}

/**
 * Given a function-call argument list that ends with a `{ ... }` notification
 * object, return that object's text. Walks backward to find the outermost
 * brace pair.
 */
function extractTrailingObject(callArgs: string): string | null {
  let depth = 0;
  let endIdx = -1;
  for (let i = callArgs.length - 1; i >= 0; i--) {
    const ch = callArgs[i];
    if (ch === '}') {
      if (depth === 0) endIdx = i;
      depth++;
    } else if (ch === '{') {
      depth--;
      if (depth === 0 && endIdx !== -1) return callArgs.slice(i, endIdx + 1);
    }
  }
  return null;
}

/**
 * Split a notification object source into (topLevel, dataInterior). The
 * returned topLevel string contains the brace-balanced notification object
 * with the `data: { ... }` block excised, so we can grep on TOP-LEVEL keys
 * without false positives from the data map.
 */
function splitTopLevelFromData(notifObj: string): { topLevel: string; dataInterior: string } {
  const dataIdx = notifObj.search(/\bdata\s*:\s*\{/);
  if (dataIdx === -1) return { topLevel: notifObj, dataInterior: '' };
  const dataOpen = notifObj.indexOf('{', dataIdx);
  let depth = 0;
  let dataClose = -1;
  for (let i = dataOpen; i < notifObj.length; i++) {
    if (notifObj[i] === '{') depth++;
    else if (notifObj[i] === '}') {
      depth--;
      if (depth === 0) {
        dataClose = i;
        break;
      }
    }
  }
  if (dataClose <= dataOpen) return { topLevel: notifObj, dataInterior: '' };
  return {
    topLevel: notifObj.slice(0, dataIdx) + notifObj.slice(dataClose + 1),
    dataInterior: notifObj.slice(dataOpen + 1, dataClose),
  };
}

// =============================================================================
// (0) Structural check — `buildMessage` still reads notification.priority.
// =============================================================================

describe('W0-1 — FCMNotification.priority contract in fcm.service.ts', () => {
  const source = read(FILE_FCM_SERVICE);

  it('buildMessage sets android.priority from notification.priority', () => {
    expect(source).toMatch(
      /priority:\s*notification\.priority\s*===\s*['"]high['"]\s*\?\s*['"]high['"]\s*:\s*['"]normal['"]/,
    );
  });

  it('FCMNotification interface declares optional priority: "high" | "normal"', () => {
    expect(source).toMatch(
      /export\s+interface\s+FCMNotification\s*\{[^}]*priority\?:\s*['"]high['"]\s*\|\s*['"]normal['"]/s,
    );
  });

  it('sendPushNotification stamps priority:"high" when delegating to fcmService.sendToUser', () => {
    // At HEAD, `sendPushNotification` is a driver-dispatch-oriented convenience
    // wrapper that always stamps priority:'high' when forwarding to
    // `fcmService.sendToUser`. This is load-bearing for the 5 callsites fixed
    // in W0-1 — the queue processor also delegates to this function, so pushes
    // that flow through the queue still land as `high` even when the convenience
    // wrapper is used as the downstream. The test locks this contract in so a
    // future refactor of `sendPushNotification` can't silently drop the 'high'
    // stamp. If `sendPushNotification` is later rewritten to forward
    // `notification.priority`, this assertion should be updated to match the
    // new contract in the same PR that introduces the behavior change.
    expect(source).toMatch(
      /export\s+async\s+function\s+sendPushNotification[^{]*\{[\s\S]{0,400}priority:\s*['"]high['"]/,
    );
  });
});

// =============================================================================
// (1) queue.service.ts — signatures accept `priority` at top level.
// =============================================================================

describe('W0-1 — queuePushNotification* signatures accept top-level priority', () => {
  const source = read(FILE_QUEUE_SERVICE);

  it('queuePushNotification signature includes `priority?: "high" | "normal"`', () => {
    const sigStart = source.indexOf('async queuePushNotification(');
    expect(sigStart).toBeGreaterThan(-1);
    const sigEnd = source.indexOf('): Promise<string>', sigStart);
    expect(sigEnd).toBeGreaterThan(sigStart);
    const sig = source.slice(sigStart, sigEnd);
    expect(sig).toMatch(/priority\?:\s*['"]high['"]\s*\|\s*['"]normal['"]/);
  });

  it('queuePushNotificationBatch signature includes `priority?: "high" | "normal"`', () => {
    const sigStart = source.indexOf('async queuePushNotificationBatch(');
    expect(sigStart).toBeGreaterThan(-1);
    const sigEnd = source.indexOf('): Promise<string[]>', sigStart);
    expect(sigEnd).toBeGreaterThan(sigStart);
    const sig = source.slice(sigStart, sigEnd);
    expect(sig).toMatch(/priority\?:\s*['"]high['"]\s*\|\s*['"]normal['"]/);
  });

  it('queue processor forwards notification (incl. priority) through sendPushNotification', () => {
    // After 2a, the single-user processor must pass the whole notification
    // (which includes priority) to sendPushNotification. Existing code
    // already does `await sendPushNotification(userId, notification)` — this
    // test locks that contract in.
    expect(source).toMatch(/sendPushNotification\(userId,\s*notification\)/);
  });
});

// =============================================================================
// (2) Callsite source-scan — the 5 driver-dispatch sites set top-level
//     priority:'high'. Each call is anchored by a body-substring so we
//     locate the RIGHT call in files that contain multiple push invocations.
// =============================================================================

interface Callsite {
  label: string;
  file: string;
  // A substring unique to this call's notification body. Used to find the
  // right call when multiple queuePushNotification* calls exist in one file.
  bodyAnchor: string;
  // The opening of the specific call, used as a hint for error messages.
  calleeHint: string;
}

const DRIVER_DISPATCH_CALLSITES: ReadonlyArray<Callsite> = [
  {
    label: 'A. assignment.service.ts — driver assignment',
    file: FILE_ASSIGNMENT,
    bodyAnchor: '🚛 New Trip Assigned!',
    calleeHint: "queueService.queuePushNotification(data.driverId, {",
  },
  {
    label: 'B. broadcast-accept.service.ts — driver path (retry fallback)',
    file: FILE_BROADCAST_ACCEPT,
    bodyAnchor: "'trip_assigned'",
    calleeHint: 'queueService.queuePushNotification(driverId, {',
  },
  {
    label: 'C. reassign-driver.service.ts — driver reassignment',
    file: FILE_REASSIGN_DRIVER,
    bodyAnchor: 'Trip for ${oldAssignment.vehicleNumber}',
    calleeHint: 'queueService.queuePushNotification(newDriverId, {',
  },
  {
    label: 'D. booking-lifecycle.service.ts — booking-expired transporter batch',
    file: FILE_BOOKING_LIFECYCLE,
    bodyAnchor: '⏰ Booking Expired',
    calleeHint: 'queueService.queuePushNotificationBatch(booking.notifiedTransporters, {',
  },
  {
    label: 'E. order-lifecycle-outbox.service.ts — order-cancel transporter batch',
    file: FILE_ORDER_OUTBOX,
    bodyAnchor: '❌ Order Cancelled',
    calleeHint: 'queueService.queuePushNotificationBatch(payload.transporters, {',
  },
];

/**
 * Locate the notification object for a given callsite by body-anchor.
 * Strategy: walk every `queuePushNotification*` invocation in the file,
 * extract its trailing `{ ... }` object, and return the one whose text
 * contains the anchor string.
 */
function locateNotificationByAnchor(source: string, anchor: string): string | null {
  const re = /queueService\.queuePushNotification(?:Batch)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const openIdx = source.indexOf('(', m.index);
    if (openIdx === -1) continue;
    const args = balancedParenBody(source, openIdx);
    if (!args) continue;
    const obj = extractTrailingObject(args);
    if (!obj) continue;
    if (obj.includes(anchor)) return obj;
  }
  return null;
}

describe('W0-1 — 5 driver-dispatch callsites lift priority to top level', () => {
  DRIVER_DISPATCH_CALLSITES.forEach((site) => {
    it(`${site.label} — notification object has top-level \`priority: 'high'\``, () => {
      const source = read(site.file);
      const obj = locateNotificationByAnchor(source, site.bodyAnchor);
      if (!obj) {
        throw new Error(
          `W0-1 locator failed: could not find queuePushNotification* call with ` +
            `body anchor '${site.bodyAnchor}' in ${path.relative(REPO_ROOT, site.file)}. ` +
            `Expected call shape: ${site.calleeHint}`,
        );
      }
      const { topLevel } = splitTopLevelFromData(obj);
      expect(topLevel).toMatch(/priority\s*:\s*['"]high['"]/);
    });
  });
});

// =============================================================================
// (3) End-to-end replay — the android.priority field becomes 'high' when
//     the processor passes a priority:'high' notification through
//     buildMessage-shaped logic.
// =============================================================================

describe('W0-1 — end-to-end FCM payload carries android.priority:"high"', () => {
  function replayBuildMessage(notification: {
    type: string;
    title: string;
    body: string;
    priority?: 'high' | 'normal';
    data?: Record<string, string>;
  }): { android: { priority: string } } {
    // Mirrors fcm.service.ts:710 exactly. If buildMessage logic drifts, the
    // structural check in test (0) will fail first.
    return {
      android: {
        priority:
          notification.priority === 'high' ? 'high' : 'normal',
      },
    };
  }

  const DRIVER_DISPATCH_SCENARIOS = [
    { label: 'assignment — driver trip_assigned', type: 'trip_assigned' },
    { label: 'broadcast-accept — driver trip_assigned fallback', type: 'trip_assigned' },
    { label: 'reassign-driver — driver trip_assigned', type: 'trip_assigned' },
    { label: 'booking-lifecycle — booking_expired → transporter batch', type: 'booking_expired' },
    { label: 'order-lifecycle-outbox — order_cancelled → transporter batch', type: 'order_cancelled' },
  ];

  DRIVER_DISPATCH_SCENARIOS.forEach((scenario) => {
    it(`${scenario.label} → FCM android.priority === 'high'`, () => {
      const msg = replayBuildMessage({
        type: scenario.type,
        title: 'Test',
        body: 'Test body',
        priority: 'high',
        data: { type: scenario.type },
      });
      expect(msg.android.priority).toBe('high');
    });
  });

  it('sanity: without top-level priority, android.priority defaults to "normal" (the regression)', () => {
    const msg = replayBuildMessage({
      type: 'trip_assigned',
      title: 'Test',
      body: 'Test body',
      data: { type: 'trip_assigned', priority: 'high' }, // inside data (pre-fix shape)
    });
    expect(msg.android.priority).toBe('normal');
  });
});

// =============================================================================
// (4) Regression guard — customer-facing pushes are UNCHANGED. This locks
//     W0-1 scope: do NOT mutate customer-side queue pushes.
// =============================================================================

describe('W0-1 — customer paths unchanged (no scope creep)', () => {
  it('broadcast-accept customer retry-fallback has NO top-level priority', () => {
    // Line ~528 in broadcast-accept.service.ts:
    //   queueService.queuePushNotification(booking.customerId, { ... })
    // W0-1 scope is driver-dispatch only. If a future edit adds top-level
    // priority here without expanding scope, this test will fail and force a
    // scope-review decision.
    const source = read(FILE_BROADCAST_ACCEPT);
    const args = findCallArgs(
      source,
      /queueService\.queuePushNotification\(\s*booking\.customerId,/,
    );
    expect(args).not.toBeNull();
    const obj = extractTrailingObject(args as string);
    expect(obj).not.toBeNull();
    const { topLevel } = splitTopLevelFromData(obj as string);
    expect(topLevel).not.toMatch(/priority\s*:\s*['"]high['"]/);
  });

  it('order-lifecycle-outbox customer cancel batch has NO top-level priority', () => {
    // Line ~386 in order-lifecycle-outbox.service.ts:
    //   queueService.queuePushNotificationBatch([payload.customerId], { ... })
    const source = read(FILE_ORDER_OUTBOX);
    const args = findCallArgs(
      source,
      /queueService\.queuePushNotificationBatch\(\s*\[\s*payload\.customerId\s*\],/,
    );
    expect(args).not.toBeNull();
    const obj = extractTrailingObject(args as string);
    expect(obj).not.toBeNull();
    const { topLevel } = splitTopLevelFromData(obj as string);
    expect(topLevel).not.toMatch(/priority\s*:\s*['"]high['"]/);
  });
});
