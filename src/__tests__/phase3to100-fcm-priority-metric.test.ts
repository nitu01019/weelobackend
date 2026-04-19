/**
 * =============================================================================
 * W0-4 — FCM push priority canary metric (Phase 3 -> 100% push)
 * =============================================================================
 *
 * BACKGROUND
 *   W0-1 fixed a silent regression where Android driver FCM pushes dropped
 *   from `priority:"high"` to `priority:"normal"` (commit 4d071a1). There is
 *   no observability to confirm that W0-1's fix actually shipped the right
 *   priority in prod — a regression could slip in silently again.
 *
 * THIS TEST ENFORCES THAT:
 *   (1) `fcm_push_priority_total` is registered in `metrics-definitions.ts`
 *       (single source of truth per CLAUDE.md 2026-04-11 refactor).
 *   (2) On every `fcmAdmin.messaging().send()` call path, the counter is
 *       incremented with the `priority` label derived from
 *       `notification.priority` (same logic `buildMessage` uses to populate
 *       `android.priority`).
 *   (3) The counter carries a `type` label (NEW_BROADCAST, ASSIGNMENT_UPDATE,
 *       TRIP_UPDATE, PAYMENT, GENERAL, etc.) so alerts can slice by
 *       notification category.
 *   (4) Sending 3 notifications with priorities ['high', 'high', 'normal']
 *       produces counter values {priority="high"} = 2 and {priority="normal"} = 1.
 *   (5) Counter is exposed via Prometheus formatting (`/metrics` endpoint).
 *
 * ALERT (documented, ops-team territory — NOT created as a file here):
 *   Alert: fcm_priority_normal_ratio
 *   Expression:
 *     sum(rate(fcm_push_priority_total{priority="normal"}[5m])) /
 *     sum(rate(fcm_push_priority_total[5m]))
 *   Threshold: > 0.2 for 15m → investigate dispatch lag
 *   Severity: WARN
 *
 * RED-GREEN LIFECYCLE:
 *   - Commit 1 (this file, RED): counter not registered + increment call
 *     absent → all expectations fail.
 *   - Commit 2 (fix): register in metrics-definitions.ts + wire increment
 *     inside `buildMessage` just before the `return {...}` block. All tests
 *     go green.
 *
 * @fixes W0-4
 * @see .planning/phase3-to-100-plan.md section "Agent W0-4"
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockRedisService = {
  isRedisEnabled: jest.fn().mockReturnValue(true),
  isConnected: jest.fn().mockReturnValue(true),
  sAdd: jest.fn().mockResolvedValue(1),
  sRem: jest.fn().mockResolvedValue(1),
  sMembers: jest.fn().mockResolvedValue(['tok-a']),
  expire: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(1),
  get: jest.fn().mockResolvedValue(null),
};

jest.mock('../shared/services/logger.service', () => ({
  logger: mockLogger,
}));

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisService,
}));

const mockPrismaClient = {
  deviceToken: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
};

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrismaClient,
}));

// firebase-admin mock — returns a stable `send` we can track.
const mockSend = jest.fn().mockResolvedValue('msg-id');
const mockSendEach = jest.fn().mockResolvedValue({ failureCount: 0, responses: [] });
const mockMessaging = jest.fn().mockReturnValue({
  send: mockSend,
  sendEachForMulticast: mockSendEach,
  subscribeToTopic: jest.fn().mockResolvedValue({}),
});

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    initializeApp: jest.fn(),
    credential: { cert: jest.fn().mockReturnValue('mock-credential') },
    messaging: mockMessaging,
  },
  initializeApp: jest.fn(),
  credential: { cert: jest.fn().mockReturnValue('mock-credential') },
  messaging: mockMessaging,
}));

// Mock fs.readFileSync only for the service account path used by initialize().
// Leave fs.readFileSync otherwise intact so other imports can read their
// own modules normally.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath.endsWith('/tmp/test-sa.json')) {
        return JSON.stringify({
          type: 'service_account',
          project_id: 'test-project',
          private_key_id: 'key-id',
          private_key:
            '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n',
          client_email: 'test@test.iam.gserviceaccount.com',
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(filePath, ...rest);
    }),
  };
});

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks are in place.
// ---------------------------------------------------------------------------

// IMPORTANT: we do NOT mock '../shared/monitoring/metrics.service' here.
// We want the real singleton so we can assert counter values on it.
import { metrics } from '../shared/monitoring/metrics.service';
import {
  fcmService,
  FCMNotification,
  NotificationType,
} from '../shared/services/fcm.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the labels map for a counter from the metrics JSON snapshot.
 * Returns `undefined` if the counter is not registered.
 */
function getCounterLabels(name: string): Record<string, number> | undefined {
  const json = metrics.getMetricsJSON();
  const counters = json.counters as Record<string, Record<string, number>>;
  return counters[name];
}

/**
 * Read the current value of a counter for a specific label set. Returns 0 if
 * the counter or label combo has not been observed yet.
 */
function readCounterValue(name: string, labels: Record<string, string>): number {
  const map = getCounterLabels(name);
  if (!map) return 0;
  const key = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return map[key] || 0;
}

function makeNotification(overrides: Partial<FCMNotification> = {}): FCMNotification {
  return {
    type: NotificationType.GENERAL,
    title: 'Test Title',
    body: 'Test Body',
    priority: 'high',
    data: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Structural checks — the counter must be registered in the central
// definitions file (CLAUDE.md: single source of truth per 2026-04-11).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const METRICS_DEFS_PATH = path.join(
  REPO_ROOT,
  'src',
  'shared',
  'monitoring',
  'metrics-definitions.ts',
);
const FCM_SERVICE_PATH = path.join(
  REPO_ROOT,
  'src',
  'shared',
  'services',
  'fcm.service.ts',
);

describe('W0-4 — fcm_push_priority_total is registered in metrics-definitions.ts', () => {
  const defsSource = fs.readFileSync(METRICS_DEFS_PATH, 'utf-8');

  it('counter name `fcm_push_priority_total` appears in registerDefaultCounters', () => {
    // Anchors on the registerDefaultCounters function body.
    const regStart = defsSource.indexOf('export function registerDefaultCounters(');
    expect(regStart).toBeGreaterThan(-1);
    // Find the matching function close (naive: look for '\n}\n' after regStart).
    const regEnd = defsSource.indexOf('\n}\n', regStart);
    expect(regEnd).toBeGreaterThan(regStart);
    const regBody = defsSource.slice(regStart, regEnd);
    expect(regBody).toMatch(/counter\(\s*['"]fcm_push_priority_total['"]/);
  });

  it('counter is registered in the metrics singleton at module load time', () => {
    // If registration happened, getMetricsJSON should include the name even
    // with no increments yet (empty labels map is fine).
    const labels = getCounterLabels('fcm_push_priority_total');
    expect(labels).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Source-shape check — the increment call exists inside buildMessage and
// carries both `priority` and `type` labels.
// ---------------------------------------------------------------------------

describe('W0-4 — fcm.service.ts buildMessage instruments priority + type', () => {
  const fcmSource = fs.readFileSync(FCM_SERVICE_PATH, 'utf-8');

  it('increments fcm_push_priority_total with priority + type labels', () => {
    // Looks for the incrementCounter call with the right name and both
    // labels. Whitespace-tolerant.
    const re = new RegExp(
      [
        "incrementCounter\\(",
        "\\s*['\"]fcm_push_priority_total['\"]",
        '[\\s\\S]{0,200}',
        'priority\\s*:',
        '[\\s\\S]{0,100}',
        'type\\s*:',
      ].join(''),
    );
    expect(fcmSource).toMatch(re);
  });

  it('increment sits inside buildMessage (between its signature and its trailing `}`)', () => {
    const sigIdx = fcmSource.indexOf(
      'private buildMessage(notification: FCMNotification',
    );
    expect(sigIdx).toBeGreaterThan(-1);
    // Find end of buildMessage — first '\n  }\n' after sigIdx at body-level
    // indent. buildMessage returns an object literal, so walk the braces.
    // Simpler: look for the counter line index and confirm it's after the
    // signature and before the next private/public/async class member.
    const incIdx = fcmSource.indexOf("'fcm_push_priority_total'", sigIdx);
    expect(incIdx).toBeGreaterThan(sigIdx);

    // Find the next class-member declaration after the signature so we can
    // bound the search — any of `  private `, `  public `, or `  async `
    // at 2-space indent inside the class body.
    const afterSig = fcmSource.slice(sigIdx + 1);
    const memberRe = /\n {2}(private|public|async|static)\s/;
    const nextMemberRel = afterSig.search(memberRe);
    expect(nextMemberRel).toBeGreaterThan(-1);
    const nextMemberAbs = sigIdx + 1 + nextMemberRel;
    expect(incIdx).toBeLessThan(nextMemberAbs);
  });
});

// ---------------------------------------------------------------------------
// Runtime behaviour — drive 3 sends through the real fcmService and confirm
// the counter captures the priority breakdown.
// ---------------------------------------------------------------------------

describe('W0-4 — counter reflects priority breakdown at runtime', () => {
  beforeAll(async () => {
    // Initialize fcmService against the mocked firebase-admin so that
    // sendToTokens routes through `this.admin.messaging().send(...)`.
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = '/tmp/test-sa.json';
    await fcmService.initialize();
  });

  afterAll(() => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisService.isRedisEnabled.mockReturnValue(true);
    mockRedisService.isConnected.mockReturnValue(true);
    mockRedisService.sMembers.mockResolvedValue(['tok-a']);
  });

  it('sends [high, high, normal] → counter shows priority="high"=+2, priority="normal"=+1', async () => {
    const beforeHigh = readCounterValue('fcm_push_priority_total', {
      priority: 'high',
      type: NotificationType.ASSIGNMENT_UPDATE,
    });
    const beforeNormal = readCounterValue('fcm_push_priority_total', {
      priority: 'normal',
      type: NotificationType.ASSIGNMENT_UPDATE,
    });

    // Three send calls — two high, one normal. All carry the same type so
    // deltas are easy to read.
    const nHigh1 = makeNotification({
      type: NotificationType.ASSIGNMENT_UPDATE,
      priority: 'high',
    });
    const nHigh2 = makeNotification({
      type: NotificationType.ASSIGNMENT_UPDATE,
      priority: 'high',
    });
    const nNormal = makeNotification({
      type: NotificationType.ASSIGNMENT_UPDATE,
      priority: 'normal',
    });

    mockSend.mockResolvedValue('msg-id');
    await fcmService.sendToTokens(['tok-1'], nHigh1, 'user-1');
    await fcmService.sendToTokens(['tok-2'], nHigh2, 'user-2');
    await fcmService.sendToTokens(['tok-3'], nNormal, 'user-3');

    const afterHigh = readCounterValue('fcm_push_priority_total', {
      priority: 'high',
      type: NotificationType.ASSIGNMENT_UPDATE,
    });
    const afterNormal = readCounterValue('fcm_push_priority_total', {
      priority: 'normal',
      type: NotificationType.ASSIGNMENT_UPDATE,
    });

    expect(afterHigh - beforeHigh).toBe(2);
    expect(afterNormal - beforeNormal).toBe(1);
  });

  it('label cardinality includes `type` — different types bucket separately', async () => {
    const before = readCounterValue('fcm_push_priority_total', {
      priority: 'high',
      type: NotificationType.NEW_BROADCAST,
    });

    mockSend.mockResolvedValue('msg-id');
    await fcmService.sendToTokens(
      ['tok-broadcast'],
      makeNotification({
        type: NotificationType.NEW_BROADCAST,
        priority: 'high',
      }),
      'user-broadcast',
    );

    const after = readCounterValue('fcm_push_priority_total', {
      priority: 'high',
      type: NotificationType.NEW_BROADCAST,
    });

    expect(after - before).toBe(1);

    // And a different type doesn't leak.
    const paymentCount = readCounterValue('fcm_push_priority_total', {
      priority: 'high',
      type: NotificationType.PAYMENT,
    });
    expect(paymentCount).toBe(0);
  });

  it('counter defaults undefined priority to "normal" (mirrors buildMessage logic)', async () => {
    const before = readCounterValue('fcm_push_priority_total', {
      priority: 'normal',
      type: NotificationType.TRIP_UPDATE,
    });

    mockSend.mockResolvedValue('msg-id');
    // Notification with NO priority field — buildMessage will default to
    // `normal` for android.priority, and the counter must agree.
    const notif: FCMNotification = {
      type: NotificationType.TRIP_UPDATE,
      title: 't',
      body: 'b',
      // priority deliberately omitted
    };
    await fcmService.sendToTokens(['tok-none'], notif, 'user-none');

    const after = readCounterValue('fcm_push_priority_total', {
      priority: 'normal',
      type: NotificationType.TRIP_UPDATE,
    });

    expect(after - before).toBe(1);
  });

  it('counter appears in Prometheus output with correct TYPE line', async () => {
    // Force at least one observation so the counter has a label-line in the
    // output. (Prom formatter emits HELP/TYPE unconditionally for registered
    // counters, but label rows require at least one increment.)
    mockSend.mockResolvedValue('msg-id');
    await fcmService.sendToTokens(
      ['tok-prom'],
      makeNotification({ type: NotificationType.GENERAL, priority: 'high' }),
      'user-prom',
    );

    const prom = metrics.getPrometheusMetrics();
    expect(prom).toContain('# TYPE fcm_push_priority_total counter');
    expect(prom).toMatch(
      /fcm_push_priority_total\{priority="high",type="general"\}\s+\d+/,
    );
  });
});
