/**
 * =============================================================================
 * F-C-50 — `flex_hold_started` socket emit on FLEX hold creation
 * =============================================================================
 *
 * Tests that `FlexHoldService.createFlexHold` emits a `flex_hold_started`
 * socket event after the ledger row is created. This is the kick-off signal
 * PRD-7777 defines for Phase-1 hold and was previously missing (REST-only
 * path meant a lost HTTP response would leave the captain UI stuck).
 *
 * Coverage:
 *   - emit fires to transporter with the 7 canonical payload fields
 *   - emit mirrors to customer room when parentOrder.customerId is set
 *   - emit is skipped (customer-side only) when parentOrder has no customerId
 *   - FCM_FALLBACK_EVENTS includes `'flex_hold_started'` (offline push)
 *   - `SocketEvent.FLEX_HOLD_STARTED` constant = `'flex_hold_started'`
 *
 * Owner: b3-kiran (Team BRAVO, Wave 0)
 * Issue: F-C-50 per WEELO-CRITICAL-SOLUTION.md
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before imports
// =============================================================================

const mockPrismaClientFc50: any = {
  truckHoldLedger: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
  },
  // F-A-75: validateActorEligibility reads User via $queryRaw ... FOR UPDATE.
  $queryRaw: jest.fn().mockResolvedValue([{ isActive: true, kycStatus: 'VERIFIED' }]),
  $transaction: jest.fn(async (fnOrArray: any) => {
    if (typeof fnOrArray === 'function') return fnOrArray(mockPrismaClientFc50);
    return Promise.all(fnOrArray);
  }),
};

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: mockPrismaClientFc50,
  withDbTimeout: jest.fn(async (fn: any, _opts?: any) => fn(mockPrismaClientFc50)),
  HoldPhase: { FLEX: 'FLEX', CONFIRMED: 'CONFIRMED', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED' },
}));

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

const mockRedisServiceFc50 = {
  acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  setJSON: jest.fn().mockResolvedValue('OK'),
  getJSON: jest.fn().mockResolvedValue(null),
  sAdd: jest.fn().mockResolvedValue(1),
  sRem: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(true),
  ttl: jest.fn().mockResolvedValue(60),
  sMembers: jest.fn().mockResolvedValue([]),
  sIsMember: jest.fn().mockResolvedValue(false),
  exists: jest.fn().mockResolvedValue(false),
  hSet: jest.fn().mockResolvedValue(1),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisServiceFc50,
}));

const mockSocketEmitToUserFc50 = jest.fn().mockResolvedValue(undefined);

jest.mock('../shared/services/socket.service', () => ({
  socketService: {
    emitToUser: mockSocketEmitToUserFc50,
  },
  emitToUser: mockSocketEmitToUserFc50,
  SocketEvent: {
    FLEX_HOLD_STARTED: 'flex_hold_started',
    FLEX_HOLD_EXTENDED: 'flex_hold_extended',
  },
}));

jest.mock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
  holdExpiryCleanupService: {
    scheduleFlexHoldCleanup: jest.fn().mockResolvedValue(undefined),
    processExpiredHold: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-f-c-50'),
}));

// =============================================================================
// TESTS
// =============================================================================

describe('F-C-50: flex_hold_started socket emit on FLEX hold creation', () => {
  const baseRequest = {
    orderId: 'order-1',
    transporterId: 'transporter-1',
    vehicleType: 'truck',
    vehicleSubtype: '6-wheel',
    quantity: 1,
    truckRequestIds: ['tr-1'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketEmitToUserFc50.mockResolvedValue(undefined);
    mockRedisServiceFc50.acquireLock.mockResolvedValue({ acquired: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Transporter emit with 7 canonical payload fields
  // -------------------------------------------------------------------------
  test('1: emits flex_hold_started to transporter after ledger.create with canonical payload', async () => {
    const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

    const expiresAtFuture = new Date(Date.now() + 10 * 60 * 1000);
    mockPrismaClientFc50.order.findUnique.mockResolvedValueOnce({
      expiresAt: expiresAtFuture,
      status: 'active',
      customerId: null, // customer mirror covered in test 2
    });
    mockPrismaClientFc50.truckHoldLedger.findFirst.mockResolvedValueOnce(null);
    mockPrismaClientFc50.truckHoldLedger.create.mockResolvedValueOnce({
      holdId: 'test-uuid-f-c-50',
      phase: 'FLEX',
      flexExpiresAt: new Date(),
      expiresAt: new Date(),
    });

    const result = await flexHoldService.createFlexHold(baseRequest);

    expect(result.success).toBe(true);

    // Find the transporter-targeted emit
    const transporterEmit = mockSocketEmitToUserFc50.mock.calls.find(
      (call) => call[0] === 'transporter-1' && call[1] === 'flex_hold_started'
    );
    expect(transporterEmit).toBeDefined();

    const payload = transporterEmit![2];
    // Assert all 7 PRD-7777 fields are present
    expect(payload).toEqual(
      expect.objectContaining({
        holdId: expect.any(String),
        orderId: 'order-1',
        phase: 'FLEX',
        expiresAt: expect.any(String), // ISO string
        baseDurationSeconds: 90,
        canExtend: true,
        maxExtensions: 2,
      })
    );
    // expiresAt must be a valid ISO timestamp
    expect(() => new Date(payload.expiresAt).toISOString()).not.toThrow();
    expect(new Date(payload.expiresAt).toString()).not.toBe('Invalid Date');
  });

  // -------------------------------------------------------------------------
  // Test 2: Customer-room mirror when customerId is present
  // -------------------------------------------------------------------------
  test('2: also emits flex_hold_started to customer room when parentOrder.customerId is set', async () => {
    const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

    mockPrismaClientFc50.order.findUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      status: 'active',
      customerId: 'customer-42',
    });
    mockPrismaClientFc50.truckHoldLedger.findFirst.mockResolvedValueOnce(null);
    mockPrismaClientFc50.truckHoldLedger.create.mockResolvedValueOnce({
      holdId: 'test-uuid-f-c-50',
      phase: 'FLEX',
      flexExpiresAt: new Date(),
      expiresAt: new Date(),
    });

    await flexHoldService.createFlexHold(baseRequest);

    // Two emits: one to transporter-1, one to customer-42 — both with event flex_hold_started
    const flexHoldStartedCalls = mockSocketEmitToUserFc50.mock.calls.filter(
      (call) => call[1] === 'flex_hold_started'
    );
    expect(flexHoldStartedCalls).toHaveLength(2);

    const recipients = flexHoldStartedCalls.map((call) => call[0]).sort();
    expect(recipients).toEqual(['customer-42', 'transporter-1']);

    // Payload parity — both emits carry the same payload shape
    const transporterPayload = flexHoldStartedCalls.find((c) => c[0] === 'transporter-1')![2];
    const customerPayload = flexHoldStartedCalls.find((c) => c[0] === 'customer-42')![2];
    expect(customerPayload).toEqual(transporterPayload);
  });

  // -------------------------------------------------------------------------
  // Test 3: No customer emit when customerId is null
  // -------------------------------------------------------------------------
  test('3: skips customer mirror emit when parentOrder.customerId is null', async () => {
    const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

    mockPrismaClientFc50.order.findUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      status: 'active',
      customerId: null,
    });
    mockPrismaClientFc50.truckHoldLedger.findFirst.mockResolvedValueOnce(null);
    mockPrismaClientFc50.truckHoldLedger.create.mockResolvedValueOnce({
      holdId: 'test-uuid-f-c-50',
      phase: 'FLEX',
      flexExpiresAt: new Date(),
      expiresAt: new Date(),
    });

    await flexHoldService.createFlexHold(baseRequest);

    const flexHoldStartedCalls = mockSocketEmitToUserFc50.mock.calls.filter(
      (call) => call[1] === 'flex_hold_started'
    );
    // Exactly one emit — to transporter — no customer mirror
    expect(flexHoldStartedCalls).toHaveLength(1);
    expect(flexHoldStartedCalls[0][0]).toBe('transporter-1');
  });

  // -------------------------------------------------------------------------
  // Test 4: No emit when createFlexHold returns existing hold (dedup)
  // -------------------------------------------------------------------------
  test('4: does NOT emit flex_hold_started on dedup (existing active hold)', async () => {
    const { flexHoldService } = require('../modules/truck-hold/flex-hold.service');

    mockPrismaClientFc50.order.findUnique.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      status: 'active',
      customerId: 'customer-42',
    });
    // Dedup: existing hold returned — create path is skipped
    mockPrismaClientFc50.truckHoldLedger.findFirst.mockResolvedValueOnce({
      holdId: 'existing-hold',
      orderId: 'order-1',
      transporterId: 'transporter-1',
      phase: 'FLEX',
      expiresAt: new Date(Date.now() + 60_000),
      flexExtendedCount: 0,
    });

    const result = await flexHoldService.createFlexHold(baseRequest);

    expect(result.success).toBe(true);
    expect(result.holdId).toBe('existing-hold');
    // Emit must NOT fire on dedup — this is NOT a new hold kickoff
    const flexHoldStartedCalls = mockSocketEmitToUserFc50.mock.calls.filter(
      (call) => call[1] === 'flex_hold_started'
    );
    expect(flexHoldStartedCalls).toHaveLength(0);
    // And ledger.create must not be called
    expect(mockPrismaClientFc50.truckHoldLedger.create).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SOURCE-LEVEL CHECKS — FCM fallback whitelist + SocketEvent constant
// =============================================================================

describe('F-C-50: socket.service constants + FCM fallback', () => {
  test('5: FCM_FALLBACK_EVENTS includes flex_hold_started', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );

    // Find the FCM_FALLBACK_EVENTS set literal
    const fcmFallbackMatch = source.match(/const FCM_FALLBACK_EVENTS = new Set\(\[[\s\S]*?\]\);/);
    expect(fcmFallbackMatch).not.toBeNull();
    const block = fcmFallbackMatch![0];
    expect(block).toContain("'flex_hold_started'");
  });

  test('6: SocketEvent.FLEX_HOLD_STARTED maps to flex_hold_started', () => {
    const fs = require('fs');
    const path = require('path');
    // F-C-52: SocketEvent map moved to packages/contracts/events.generated.ts;
    // read both so the assertion holds whether the constant is declared inline
    // (legacy) or imported from the canonical contracts registry.
    const socketSrc = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );
    const contractsPath = path.resolve(__dirname, '../../packages/contracts/events.generated.ts');
    const contractsSrc = fs.existsSync(contractsPath) ? fs.readFileSync(contractsPath, 'utf-8') : '';
    const source = socketSrc + '\n' + contractsSrc;

    // Canonical constant declaration inside the SocketEvent map
    expect(source).toMatch(/FLEX_HOLD_STARTED:\s*'flex_hold_started'/);
  });
});
