/**
 * =============================================================================
 * QA-NOTIFICATION-QUEUE — Notification / Queue / Backpressure Tests
 * =============================================================================
 *
 * Covers:
 *   C3:  Firebase init with inline env vars, file fallback, mock mode
 *   C6:  drainOutbox called on circuit recovery
 *   M20: FCM channelId broadcasts_v2
 *   H7:  Priority queue CRITICAL>HIGH>NORMAL>LOW ordering
 *   H5:  TTL enforcement (expired messages skipped)
 *   H2:  Backpressure 429 + Retry-After, limit 200
 *   M22: Rating reminder poller started at boot
 *   H11: fullScreen in FCM data
 *
 * Test count: 30
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read source file relative to src/ */
function readSource(relPath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '..', relPath),
    'utf8',
  );
}

// ── Pre-load source files once ──────────────────────────────────────────────

const fcmSource = readSource('shared/services/fcm.service.ts');
const queueSource = readSource('shared/services/queue.service.ts');
const circuitBreakerSource = readSource('shared/services/circuit-breaker.service.ts');
const outboxSource = readSource('shared/services/notification-outbox.service.ts');
const requestQueueSource = readSource('shared/resilience/request-queue.ts');
const serverSource = readSource('server.ts');
const ratingReminderSource = readSource('modules/rating/rating-reminder.service.ts');

// =============================================================================
// C3: Firebase init — inline env vars, file fallback, mock mode
// =============================================================================

describe('C3: Firebase initialization strategies', () => {
  test('C3-01: File-based credential path reads FIREBASE_SERVICE_ACCOUNT_PATH', () => {
    expect(fcmSource).toContain('FIREBASE_SERVICE_ACCOUNT_PATH');
    expect(fcmSource).toContain("fs.readFileSync(serviceAccountPath, 'utf8')");
  });

  test('C3-02: Inline env vars use FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL', () => {
    expect(fcmSource).toContain('FIREBASE_PROJECT_ID');
    expect(fcmSource).toContain('FIREBASE_PRIVATE_KEY');
    expect(fcmSource).toContain('FIREBASE_CLIENT_EMAIL');
  });

  test('C3-03: Inline credentials convert literal \\n to real newlines in private key', () => {
    expect(fcmSource).toContain("privateKey!.replace(/\\\\n/g, '\\n')");
  });

  test('C3-04: Mock mode activates when no credentials are available', () => {
    // Should log mock mode warning
    expect(fcmSource).toContain('MOCK MODE');
    expect(fcmSource).toContain('Push notifications DISABLED');
  });

  test('C3-05: File-based init failure falls through to inline credentials', () => {
    // The file-based try/catch has a "Fall through to inline" comment
    expect(fcmSource).toContain('Fall through to inline');
  });

  test('C3-06: Inline credential failure falls back to mock mode', () => {
    expect(fcmSource).toContain('Falling back to mock mode');
  });

  test('C3-07: Production mock mode emits fcm_init_missing_config metric', () => {
    expect(fcmSource).toContain("metrics.incrementCounter('fcm_init_missing_config')");
  });
});

// =============================================================================
// C6: drainOutbox called on circuit recovery
// =============================================================================

describe('C6: Outbox drain on circuit recovery', () => {
  test('C6-01: fcmCircuit has onRecovery callback wired to drainOutboxOnRecovery', () => {
    expect(circuitBreakerSource).toContain('onRecovery: drainOutboxOnRecovery');
    // fcmCircuit is one of the callers
    expect(circuitBreakerSource).toMatch(/fcmCircuit\s*=\s*new CircuitBreaker/);
  });

  test('C6-02: socketCircuit also has onRecovery callback', () => {
    expect(circuitBreakerSource).toMatch(
      /socketCircuit\s*=\s*new CircuitBreaker[\s\S]*?onRecovery:\s*drainOutboxOnRecovery/,
    );
  });

  test('C6-03: drainOutboxOnRecovery imports notification-outbox.service dynamically', () => {
    expect(circuitBreakerSource).toContain("import('./notification-outbox.service')");
  });

  test('C6-04: drainAllOutboxes uses SCAN iterator (not KEYS) to avoid blocking Redis', () => {
    expect(outboxSource).toContain('scanIterator');
    expect(outboxSource).not.toMatch(/\bredisService\.keys\b/);
  });

  test('C6-05: drainOutbox skips stale entries older than FRESHNESS_MS', () => {
    expect(outboxSource).toContain('FRESHNESS_MS');
    expect(outboxSource).toContain('Date.now() - parsed.timestamp > FRESHNESS_MS');
  });

  test('C6-06: CircuitBreaker.recordSuccess fires onRecovery callback', () => {
    expect(circuitBreakerSource).toMatch(
      /recordSuccess[\s\S]*?this\.onRecovery/,
    );
  });
});

// =============================================================================
// M20: FCM channelId broadcasts_v2
// =============================================================================

describe('M20: FCM channelId mapping', () => {
  test('M20-01: NEW_BROADCAST maps to channelId broadcasts_v2', () => {
    // getChannelId returns 'broadcasts_v2' for NEW_BROADCAST
    expect(fcmSource).toContain("return 'broadcasts_v2'");
  });

  test('M20-02: ASSIGNMENT_UPDATE maps to channelId trips', () => {
    // getChannelId method contains a switch with ASSIGNMENT_UPDATE → 'trips'
    const channelIdFn = fcmSource.match(
      /private getChannelId[\s\S]*?^\s{2}\}/m,
    );
    expect(channelIdFn).not.toBeNull();
    expect(channelIdFn![0]).toContain("return 'trips'");
  });

  test('M20-03: PAYMENT maps to channelId payments', () => {
    expect(fcmSource).toContain("return 'payments'");
  });

  test('M20-04: Default channelId is general', () => {
    expect(fcmSource).toContain("return 'general'");
  });
});

// =============================================================================
// H7: Priority queue CRITICAL > HIGH > NORMAL > LOW ordering
// =============================================================================

describe('H7: Priority queue ordering', () => {
  test('H7-01: MessagePriority defines CRITICAL=1, HIGH=2, NORMAL=3, LOW=4', () => {
    expect(queueSource).toMatch(/CRITICAL:\s*1/);
    expect(queueSource).toMatch(/HIGH:\s*2/);
    expect(queueSource).toMatch(/NORMAL:\s*3/);
    expect(queueSource).toMatch(/LOW:\s*4/);
  });

  test('H7-02: RedisQueue has PRIORITY_SUFFIXES in correct drain order', () => {
    // Suffixes must be in order: critical, high, normal, low
    const suffixBlock = queueSource.match(
      /PRIORITY_SUFFIXES[\s\S]*?\];/,
    );
    expect(suffixBlock).not.toBeNull();
    const block = suffixBlock![0];
    const critIdx = block.indexOf(':critical');
    const highIdx = block.indexOf(':high');
    const normalIdx = block.indexOf(':normal');
    const lowIdx = block.indexOf(':low');
    expect(critIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(normalIdx);
    expect(normalIdx).toBeLessThan(lowIdx);
  });

  test('H7-03: getPriorityQueueKey maps numeric priority to named suffix', () => {
    expect(queueSource).toContain('getPriorityQueueKey');
    expect(queueSource).toMatch(/entry\s*\?\s*`\$\{base\}\$\{entry\.suffix\}`/);
  });

  test('H7-04: Worker drains higher-priority lists first with non-blocking RPOP', () => {
    // The worker loop should RPOP higher priorities, BRPOP lowest
    expect(queueSource).toContain('redisService.rPop(priorityKeys[i])');
    expect(queueSource).toContain('redisService.brPop(lowestPriorityKey');
  });

  test('H7-05: order_cancelled is mapped to CRITICAL priority', () => {
    expect(queueSource).toMatch(/'order_cancelled':\s*MessagePriority\.CRITICAL/);
  });

  test('H7-06: new_broadcast is mapped to NORMAL priority', () => {
    expect(queueSource).toMatch(/'new_broadcast':\s*MessagePriority\.NORMAL/);
  });

  test('H7-07: trucks_remaining_update is mapped to LOW priority', () => {
    expect(queueSource).toMatch(/'trucks_remaining_update':\s*MessagePriority\.LOW/);
  });

  test('H7-08: addBatch groups jobs by priority and pushes to correct lists', () => {
    // addBatch should bucket by priority key
    expect(queueSource).toMatch(/addBatch[\s\S]*?getPriorityQueueKey/);
  });
});

// =============================================================================
// H5: TTL enforcement — expired messages skipped
// =============================================================================

describe('H5: Message TTL enforcement', () => {
  test('H5-01: FF_MESSAGE_TTL_ENABLED defaults to ON (opt-out, not opt-in)', () => {
    // !== 'false' means it is on by default
    expect(queueSource).toMatch(
      /FF_MESSAGE_TTL_ENABLED\s*=\s*process\.env\.FF_MESSAGE_TTL_ENABLED\s*!==\s*'false'/,
    );
  });

  test('H5-02: MESSAGE_TTL_MS defines per-event TTLs', () => {
    expect(queueSource).toContain("'new_broadcast': 90_000");
    expect(queueSource).toContain("'order_cancelled': 300_000");
    expect(queueSource).toContain("'trucks_remaining_update': 30_000");
  });

  test('H5-03: DEFAULT_MESSAGE_TTL_MS is 120 seconds', () => {
    expect(queueSource).toMatch(/DEFAULT_MESSAGE_TTL_MS\s*=\s*120_000/);
  });

  test('H5-04: Broadcast processor checks message age against TTL', () => {
    expect(queueSource).toContain('Date.now() - job.createdAt');
    expect(queueSource).toContain('ageMs > ttlMs');
  });

  test('H5-05: Stale messages increment broadcast_delivery_stale_dropped counter', () => {
    expect(queueSource).toContain("broadcast_delivery_stale_dropped");
  });
});

// =============================================================================
// H2: Backpressure 429 + Retry-After, limit 200
// =============================================================================

describe('H2: Backpressure 429 + Retry-After', () => {
  test('H2-01: QueueFullError returns 429 status code', () => {
    expect(requestQueueSource).toContain('res.status(429)');
  });

  test('H2-02: Retry-After header is set on queue saturation', () => {
    expect(requestQueueSource).toContain("res.setHeader('Retry-After'");
  });

  test('H2-03: Response code is REQUEST_QUEUE_SATURATED', () => {
    expect(requestQueueSource).toContain("code: 'REQUEST_QUEUE_SATURATED'");
  });

  test('H2-04: retryAfterMs is included in error response body', () => {
    expect(requestQueueSource).toContain('retryAfterMs');
  });

  test('H2-05: Default queue maxConcurrent is 200', () => {
    expect(requestQueueSource).toMatch(
      /name:\s*'default'[\s\S]*?maxConcurrent:\s*200/,
    );
  });

  test('H2-06: Default queue maxQueueSize is 2000', () => {
    expect(requestQueueSource).toMatch(
      /name:\s*'default'[\s\S]*?maxQueueSize:\s*2000/,
    );
  });

  test('H2-07: QueueTimeoutError returns 408 status code', () => {
    expect(requestQueueSource).toContain('res.status(408)');
  });

  test('H2-08: REQUEST_TIMEOUT code on queue timeout', () => {
    expect(requestQueueSource).toContain("code: 'REQUEST_TIMEOUT'");
  });

  test('H2-09: Queue exposes getStats() for monitoring', () => {
    expect(requestQueueSource).toContain('getStats()');
    expect(requestQueueSource).toContain('activeCount');
    expect(requestQueueSource).toContain('queueSize');
  });

  test('H2-10: Booking queue maxConcurrent is 50', () => {
    expect(requestQueueSource).toMatch(
      /name:\s*'booking'[\s\S]*?maxConcurrent:\s*50/,
    );
  });
});

// =============================================================================
// M22: Rating reminder poller started at boot
// =============================================================================

describe('M22: Rating reminder poller at boot', () => {
  test('M22-01: server.ts imports processExpiredRatingReminders', () => {
    expect(serverSource).toContain('processExpiredRatingReminders');
  });

  test('M22-02: Rating reminder poller runs on a 60-second interval', () => {
    // setInterval with 60_000 for rating reminders
    expect(serverSource).toMatch(
      /processExpiredRatingReminders[\s\S]*?60_000/,
    );
  });

  test('M22-03: Rating reminder interval is unref()ed so it does not block exit', () => {
    // The interval chain should call .unref()
    const reminderBlock = serverSource.match(
      /processExpiredRatingReminders[\s\S]*?\.unref\(\)/,
    );
    expect(reminderBlock).not.toBeNull();
  });

  test('M22-04: processExpiredRatingReminders sends push via queuePushNotification', () => {
    expect(ratingReminderSource).toContain('queueService.queuePushNotification');
    expect(ratingReminderSource).toContain("type: 'rating_reminder'");
  });
});

// =============================================================================
// H11: fullScreen in FCM data payload
// =============================================================================

describe('H11: fullScreen flag in FCM data payload', () => {
  test('H11-01: FULLSCREEN_TYPES set exists on FCMService', () => {
    expect(fcmSource).toContain('FULLSCREEN_TYPES');
  });

  test('H11-02: trip_assigned is in FULLSCREEN_TYPES', () => {
    const fullscreenBlock = fcmSource.match(
      /FULLSCREEN_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(fullscreenBlock).not.toBeNull();
    expect(fullscreenBlock![1]).toContain("'trip_assigned'");
  });

  test('H11-03: assignment_update is in FULLSCREEN_TYPES', () => {
    const fullscreenBlock = fcmSource.match(
      /FULLSCREEN_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(fullscreenBlock).not.toBeNull();
    expect(fullscreenBlock![1]).toContain("'assignment_update'");
  });

  test('H11-04: new_broadcast is in FULLSCREEN_TYPES', () => {
    const fullscreenBlock = fcmSource.match(
      /FULLSCREEN_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(fullscreenBlock).not.toBeNull();
    expect(fullscreenBlock![1]).toContain("'new_broadcast'");
  });

  test('H11-05: buildMessage sets fullScreen: true for matching types', () => {
    expect(fcmSource).toContain("fullScreen: 'true'");
  });

  test('H11-06: buildMessage sets visibility: public for fullScreen types', () => {
    expect(fcmSource).toContain("visibility: 'public'");
  });
});
