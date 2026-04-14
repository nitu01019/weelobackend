/**
 * =============================================================================
 * ORDER CRITICAL FIXES -- Tests for C1, C2, C5
 * =============================================================================
 *
 * Validates three production fixes:
 *
 *  C1: Fire-and-forget dispatch (no longer blocks HTTP response)
 *      - processDispatchOutboxImmediately is NOT awaited
 *      - Dispatch failure is caught and logged (not thrown)
 *      - Order response includes 'dispatching' dispatch state
 *      - Outbox row is still created inside the transaction
 *
 *  C2: Legacy broadcast POST /create returns 410 Gone
 *      - Returns HTTP 410 with { success: false, error: 'ENDPOINT_DEPRECATED' }
 *      - Response includes redirect message to new endpoint
 *      - No booking record is created
 *
 *  C5: driverId is optional in accept schemas
 *      - booking.schema acceptTruckRequestSchema allows missing driverId
 *      - order.routes acceptRequestSchema allows missing driverId
 *      - Both schemas reject invalid UUID formats
 *      - Both schemas still require vehicleId
 *
 * @author Test Agent T2
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
// =============================================================================

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

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// =============================================================================
// C1 TESTS: Fire-and-forget dispatch
// =============================================================================

describe('C1: Fire-and-forget dispatch (non-blocking HTTP response)', () => {

  // -------------------------------------------------------------------------
  // C1.1: Source code verifies processDispatchOutboxImmediately is NOT awaited
  // -------------------------------------------------------------------------
  describe('processDispatchOutboxImmediately is fire-and-forget', () => {
    const fs = require('fs');
    const path = require('path');
    const orderServiceSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order.service.ts'),
      'utf-8'
    );

    test('C1.1: processDispatchOutboxImmediately is called without await', () => {
      // The fix changed `await this.processDispatchOutboxImmediately(...)` to
      // `this.processDispatchOutboxImmediately(...).catch(...)` (fire-and-forget)
      const lines = orderServiceSource.split('\n');

      // Find lines that call processDispatchOutboxImmediately
      const dispatchCallLines = lines.filter((line: string) =>
        line.includes('processDispatchOutboxImmediately') &&
        !line.includes('import') &&
        !line.includes('export') &&
        !line.includes('private async processDispatchOutboxImmediately') &&
        !line.includes('return processDispatchOutboxImmediatelyFn')
      );

      expect(dispatchCallLines.length).toBeGreaterThan(0);

      // Verify NONE of the call-site lines use `await` before the call
      const awaitedCalls = dispatchCallLines.filter((line: string) =>
        line.trim().startsWith('await') && line.includes('processDispatchOutboxImmediately')
      );
      expect(awaitedCalls).toHaveLength(0);
    });

    test('C1.2: Fire-and-forget call uses .catch() for error handling', () => {
      // The pattern must be: this.processDispatchOutboxImmediately(...).catch(...)
      const hasCatchPattern = orderServiceSource.includes(
        'processDispatchOutboxImmediately(orderId, dispatchContext).catch('
      );
      expect(hasCatchPattern).toBe(true);
    });

    test('C1.3: Dispatch failure is logged as warn (not thrown)', () => {
      // The catch handler should log via logger.warn, not re-throw
      const catchBlock = orderServiceSource.match(
        /processDispatchOutboxImmediately\([^)]+\)\.catch\(\s*(?:err|e|error)\s*=>\s*\n?\s*logger\.warn\(/
      );
      expect(catchBlock).not.toBeNull();
    });

    test('C1.4: Catch handler includes orderId and error message in log', () => {
      // Verify structured logging includes orderId context
      const catchSection = orderServiceSource.match(
        /processDispatchOutboxImmediately[\s\S]{0,200}\.catch\([\s\S]{0,300}orderId/
      );
      expect(catchSection).not.toBeNull();

      const errorMessageLogged = orderServiceSource.match(
        /processDispatchOutboxImmediately[\s\S]{0,200}\.catch\([\s\S]{0,300}err\.message/
      );
      expect(errorMessageLogged).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // C1.5-C1.7: Response includes correct dispatch state when outbox is enabled
  // -------------------------------------------------------------------------
  describe('Order response includes correct dispatch state', () => {
    const fs = require('fs');
    const path = require('path');
    const orderServiceSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order.service.ts'),
      'utf-8'
    );

    test('C1.5: dispatchState is set to "dispatching" in outbox path', () => {
      // After the fire-and-forget call, dispatchState must be 'dispatching'
      // Pattern: processDispatchOutboxImmediately...catch... then dispatchState = 'dispatching'
      const lines = orderServiceSource.split('\n');
      const fireAndForgetIdx = lines.findIndex((line: string) =>
        line.includes('processDispatchOutboxImmediately') &&
        line.includes('.catch(')
      );
      expect(fireAndForgetIdx).toBeGreaterThan(-1);

      // Within the next 5 lines after fire-and-forget, dispatchState should be set to 'dispatching'
      const followingLines = lines.slice(fireAndForgetIdx, fireAndForgetIdx + 5).join('\n');
      expect(followingLines).toContain("dispatchState = 'dispatching'");
    });

    test('C1.6: dispatchReasonCode set to DISPATCH_RETRYING in outbox path', () => {
      const lines = orderServiceSource.split('\n');
      const fireAndForgetIdx = lines.findIndex((line: string) =>
        line.includes('processDispatchOutboxImmediately') &&
        line.includes('.catch(')
      );
      const followingLines = lines.slice(fireAndForgetIdx, fireAndForgetIdx + 6).join('\n');
      expect(followingLines).toContain("dispatchReasonCode = 'DISPATCH_RETRYING'");
    });

    test('C1.7: dispatchAttempts is set to 1 in outbox path', () => {
      const lines = orderServiceSource.split('\n');
      const fireAndForgetIdx = lines.findIndex((line: string) =>
        line.includes('processDispatchOutboxImmediately') &&
        line.includes('.catch(')
      );
      const followingLines = lines.slice(fireAndForgetIdx, fireAndForgetIdx + 6).join('\n');
      expect(followingLines).toContain('dispatchAttempts = 1');
    });
  });

  // -------------------------------------------------------------------------
  // C1.8-C1.9: Outbox row is created inside the transaction (before dispatch)
  // -------------------------------------------------------------------------
  describe('Outbox row created inside transaction for poller retry', () => {
    const fs = require('fs');
    const path = require('path');
    const orderServiceSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order.service.ts'),
      'utf-8'
    );

    test('C1.8: enqueueOrderDispatchOutbox is called inside the transaction', () => {
      // The outbox row must be created INSIDE the withDbTimeout transaction
      // so the poller can retry if the immediate dispatch fails.
      const hasEnqueue = orderServiceSource.includes('enqueueOrderDispatchOutbox(orderId, tx)');
      expect(hasEnqueue).toBe(true);
    });

    test('C1.9: enqueueOrderDispatchOutbox is guarded by FF_ORDER_DISPATCH_OUTBOX', () => {
      // Find the enqueue call and verify it's inside the FF guard
      const lines = orderServiceSource.split('\n');
      const enqueueIdx = lines.findIndex((line: string) =>
        line.includes('enqueueOrderDispatchOutbox(orderId, tx)')
      );
      expect(enqueueIdx).toBeGreaterThan(-1);

      // Look backwards for the FF guard — should be within 5 lines above
      const precedingLines = lines.slice(Math.max(0, enqueueIdx - 5), enqueueIdx).join('\n');
      expect(precedingLines).toContain('FF_ORDER_DISPATCH_OUTBOX');
    });

    test('C1.10: enqueueOrderDispatchOutbox is called BEFORE the fire-and-forget dispatch', () => {
      // Transaction (with enqueue) must complete before the non-blocking dispatch call.
      // enqueueOrderDispatchOutbox is inside withDbTimeout, processDispatchOutboxImmediately is after.
      const enqueuePos = orderServiceSource.indexOf('enqueueOrderDispatchOutbox(orderId, tx)');
      const fireAndForgetPos = orderServiceSource.indexOf(
        'processDispatchOutboxImmediately(orderId, dispatchContext).catch('
      );
      expect(enqueuePos).toBeLessThan(fireAndForgetPos);
    });
  });

  // -------------------------------------------------------------------------
  // C1.11: The fire-and-forget pattern does NOT use void operator
  // -------------------------------------------------------------------------
  test('C1.11: Uses .catch() pattern, not void-ignoring pattern', () => {
    const fs = require('fs');
    const path = require('path');
    const orderServiceSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/order/order.service.ts'),
      'utf-8'
    );

    // Should NOT have: void this.processDispatchOutboxImmediately (unsafe -- no error handling)
    const voidPattern = orderServiceSource.includes('void this.processDispatchOutboxImmediately');
    expect(voidPattern).toBe(false);
  });
});

// =============================================================================
// C2 TESTS: Legacy broadcast POST /create returns 410 Gone
// =============================================================================

describe('C2: Legacy broadcast POST /create returns 410 Gone', () => {
  const fs = require('fs');
  const path = require('path');
  const broadcastRoutesSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/broadcast/broadcast.routes.ts'),
    'utf-8'
  );

  // -------------------------------------------------------------------------
  // C2.1: Route exists and returns 410
  // -------------------------------------------------------------------------
  test('C2.1: POST /create route exists in broadcast.routes.ts', () => {
    expect(broadcastRoutesSource).toContain("'/create'");
    expect(broadcastRoutesSource).toContain('router.post');
  });

  test('C2.2: Returns HTTP 410 (Gone) status code', () => {
    // The route handler must call res.status(410)
    expect(broadcastRoutesSource).toContain('res.status(410)');
  });

  test('C2.3: Response body has success: false', () => {
    // Must include { success: false, ... }
    expect(broadcastRoutesSource).toContain('success: false');
  });

  test('C2.4: Response body has error: ENDPOINT_DEPRECATED', () => {
    expect(broadcastRoutesSource).toContain("error: 'ENDPOINT_DEPRECATED'");
  });

  test('C2.5: Response includes redirect message to POST /api/v1/bookings/orders', () => {
    // The message must tell the client which endpoint to use instead
    expect(broadcastRoutesSource).toContain('/api/v1/bookings/orders');
  });

  // -------------------------------------------------------------------------
  // C2.6: No booking record is created (route does NOT call broadcastService)
  // -------------------------------------------------------------------------
  test('C2.6: POST /create handler does NOT call broadcastService.create', () => {
    // Extract only the /create route handler block
    const createRouteStart = broadcastRoutesSource.indexOf("router.post('/create'");
    expect(createRouteStart).toBeGreaterThan(-1);

    // Scan forward to find the closing of this route (next router. call or end)
    const afterCreate = broadcastRoutesSource.slice(createRouteStart);
    const nextRoutePos = afterCreate.indexOf('router.', 10); // skip past 'router.post'
    const createBlock = nextRoutePos > 0
      ? afterCreate.slice(0, nextRoutePos)
      : afterCreate;

    // The handler should NOT invoke any service methods that create bookings
    expect(createBlock).not.toContain('broadcastService.create');
    expect(createBlock).not.toContain('broadcastService.createBroadcast');
    expect(createBlock).not.toContain('prismaClient');
    expect(createBlock).not.toContain('db.');
  });

  test('C2.7: POST /create is a single-line handler (no async processing)', () => {
    // A 410 stub should be minimal -- verify it uses the inline arrow pattern
    // The route should be: router.post('/create', authMiddleware, (req, res) => { res.status(410)... })
    const createMatch = broadcastRoutesSource.match(
      /router\.post\('\/create'[^;]+410[^;]+\)/
    );
    expect(createMatch).not.toBeNull();
  });

  test('C2.8: POST /create requires authMiddleware', () => {
    // Even deprecated endpoints should be behind auth to prevent abuse
    const createRouteStart = broadcastRoutesSource.indexOf("router.post('/create'");
    const lineEnd = broadcastRoutesSource.indexOf('\n', createRouteStart);
    const createLine = broadcastRoutesSource.slice(createRouteStart, lineEnd);
    expect(createLine).toContain('authMiddleware');
  });

  // -------------------------------------------------------------------------
  // C2.9: Full response shape validation
  // -------------------------------------------------------------------------
  test('C2.9: Complete 410 response has all three required fields', () => {
    // Must have: success, error, message — all in one res.status(410).json(...)
    const jsonCallMatch = broadcastRoutesSource.match(
      /res\.status\(410\)\.json\(\{([^}]+)\}\)/
    );
    expect(jsonCallMatch).not.toBeNull();

    const jsonBody = jsonCallMatch![1];
    expect(jsonBody).toContain('success:');
    expect(jsonBody).toContain('error:');
    expect(jsonBody).toContain('message:');
  });

  test('C2.10: message field contains "Use POST" directive', () => {
    // The message should clearly tell the caller what to use instead
    const messageMatch = broadcastRoutesSource.match(
      /message:\s*['"]Use POST[^'"]*['"]/
    );
    expect(messageMatch).not.toBeNull();
  });
});

// =============================================================================
// C5 TESTS: driverId is optional in accept schemas
// =============================================================================

describe('C5: driverId is optional in accept schemas', () => {

  // -------------------------------------------------------------------------
  // C5.1-C5.4: booking.schema.ts — acceptTruckRequestSchema
  // -------------------------------------------------------------------------
  describe('acceptTruckRequestSchema (booking.schema.ts)', () => {
    // Import the actual schema for runtime validation testing
    let acceptTruckRequestSchema: any;

    beforeAll(() => {
      // Dynamic import to avoid mocking issues at module level
      acceptTruckRequestSchema = require('../modules/booking/booking.schema').acceptTruckRequestSchema;
    });

    test('C5.1: Accept request WITH driverId validates successfully', () => {
      const validInput = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: '660e8400-e29b-41d4-a716-446655440001',
      };

      const result = acceptTruckRequestSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      expect(result.data.vehicleId).toBe(validInput.vehicleId);
      expect(result.data.driverId).toBe(validInput.driverId);
    });

    test('C5.2: Accept request WITHOUT driverId validates successfully', () => {
      const validInput = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
      };

      const result = acceptTruckRequestSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      expect(result.data.vehicleId).toBe(validInput.vehicleId);
      expect(result.data.driverId).toBeUndefined();
    });

    test('C5.3: Accept request with invalid driverId format gets validation error', () => {
      const invalidInput = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: 'not-a-uuid',
      };

      const result = acceptTruckRequestSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
      expect(result.error.errors[0].path).toContain('driverId');
    });

    test('C5.4: Schema allows explicit undefined driverId', () => {
      const input = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: undefined,
      };

      const result = acceptTruckRequestSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test('C5.5: vehicleId is still required (not optional)', () => {
      const missingVehicle = {
        driverId: '660e8400-e29b-41d4-a716-446655440001',
      };

      const result = acceptTruckRequestSchema.safeParse(missingVehicle);
      expect(result.success).toBe(false);
      expect(result.error.errors[0].path).toContain('vehicleId');
    });

    test('C5.6: Empty object fails validation (vehicleId required)', () => {
      const result = acceptTruckRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('C5.7: vehicleId with invalid UUID format is rejected', () => {
      const result = acceptTruckRequestSchema.safeParse({
        vehicleId: 'bad-format',
      });
      expect(result.success).toBe(false);
      expect(result.error.errors[0].path).toContain('vehicleId');
    });
  });

  // -------------------------------------------------------------------------
  // C5.8-C5.11: order.routes.ts — inline acceptRequestSchema
  // -------------------------------------------------------------------------
  describe('acceptRequestSchema (order.routes.ts)', () => {

    test('C5.8: Source confirms driverId has .optional() in order.routes.ts', () => {
      const fs = require('fs');
      const path = require('path');
      const orderRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/order/order.routes.ts'),
        'utf-8'
      );

      // Find the acceptRequestSchema definition
      const schemaMatch = orderRoutesSource.match(
        /acceptRequestSchema\s*=\s*z\.object\(\{[\s\S]*?\}\)/
      );
      expect(schemaMatch).not.toBeNull();

      const schemaDef = schemaMatch![0];

      // driverId must have .optional()
      expect(schemaDef).toContain('driverId');
      // Match the driverId line specifically for .optional()
      const driverIdLine = schemaDef.split('\n').find((l: string) => l.includes('driverId'));
      expect(driverIdLine).toBeDefined();
      expect(driverIdLine).toContain('.optional()');
    });

    test('C5.9: Source confirms driverId is z.string().uuid().optional()', () => {
      const fs = require('fs');
      const path = require('path');
      const orderRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/order/order.routes.ts'),
        'utf-8'
      );

      const schemaMatch = orderRoutesSource.match(
        /acceptRequestSchema\s*=\s*z\.object\(\{[\s\S]*?\}\)/
      );
      const schemaDef = schemaMatch![0];
      const driverIdLine = schemaDef.split('\n').find((l: string) => l.includes('driverId'));

      // Must be uuid validated, not just any string
      expect(driverIdLine).toContain('.uuid()');
    });

    test('C5.10: truckRequestId is still required (not optional) in order acceptRequestSchema', () => {
      const fs = require('fs');
      const path = require('path');
      const orderRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/order/order.routes.ts'),
        'utf-8'
      );

      const schemaMatch = orderRoutesSource.match(
        /acceptRequestSchema\s*=\s*z\.object\(\{[\s\S]*?\}\)/
      );
      const schemaDef = schemaMatch![0];
      const truckRequestIdLine = schemaDef.split('\n').find((l: string) =>
        l.includes('truckRequestId')
      );

      expect(truckRequestIdLine).toBeDefined();
      // truckRequestId should NOT have .optional()
      expect(truckRequestIdLine).not.toContain('.optional()');
    });

    test('C5.11: vehicleId is still required (not optional) in order acceptRequestSchema', () => {
      const fs = require('fs');
      const path = require('path');
      const orderRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/order/order.routes.ts'),
        'utf-8'
      );

      const schemaMatch = orderRoutesSource.match(
        /acceptRequestSchema\s*=\s*z\.object\(\{[\s\S]*?\}\)/
      );
      const schemaDef = schemaMatch![0];
      const vehicleIdLine = schemaDef.split('\n').find((l: string) =>
        l.includes('vehicleId') && !l.includes('driverId')
      );

      expect(vehicleIdLine).toBeDefined();
      // vehicleId should NOT have .optional()
      expect(vehicleIdLine).not.toContain('.optional()');
    });
  });

  // -------------------------------------------------------------------------
  // C5.12-C5.14: broadcast.routes.ts — acceptBroadcastBodySchema consistency
  // -------------------------------------------------------------------------
  describe('acceptBroadcastBodySchema consistency (broadcast.routes.ts)', () => {

    test('C5.12: broadcast accept schema also has driverId as optional', () => {
      const fs = require('fs');
      const path = require('path');
      const broadcastRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/broadcast/broadcast.routes.ts'),
        'utf-8'
      );

      const schemaMatch = broadcastRoutesSource.match(
        /acceptBroadcastBodySchema\s*=\s*z\.object\(\{[\s\S]*?\}\)/
      );
      expect(schemaMatch).not.toBeNull();

      const schemaDef = schemaMatch![0];
      const driverIdLine = schemaDef.split('\n').find((l: string) => l.includes('driverId'));
      expect(driverIdLine).toBeDefined();
      expect(driverIdLine).toContain('.optional()');
    });

    test('C5.13: All three accept schemas agree on driverId optionality', () => {
      const fs = require('fs');
      const path = require('path');

      // Schema 1: booking.schema.ts
      const bookingSchemaSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/booking/booking.schema.ts'),
        'utf-8'
      );

      // Schema 2: order.routes.ts
      const orderRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/order/order.routes.ts'),
        'utf-8'
      );

      // Schema 3: broadcast.routes.ts
      const broadcastRoutesSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/broadcast/broadcast.routes.ts'),
        'utf-8'
      );

      // Extract driverId lines from all three
      const extractDriverIdOptional = (source: string): boolean => {
        const lines = source.split('\n');
        const driverIdLines = lines.filter((l: string) =>
          l.includes('driverId') && l.includes('z.string()') && l.includes('.uuid(')
        );
        return driverIdLines.every((l: string) => l.includes('.optional()'));
      };

      expect(extractDriverIdOptional(bookingSchemaSource)).toBe(true);
      expect(extractDriverIdOptional(orderRoutesSource)).toBe(true);
      expect(extractDriverIdOptional(broadcastRoutesSource)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // C5.14-C5.16: Runtime Zod validation edge cases (booking schema)
  // -------------------------------------------------------------------------
  describe('Zod runtime edge cases for acceptTruckRequestSchema', () => {
    let acceptTruckRequestSchema: any;

    beforeAll(() => {
      acceptTruckRequestSchema = require('../modules/booking/booking.schema').acceptTruckRequestSchema;
    });

    test('C5.14: null driverId is rejected (only undefined is allowed)', () => {
      const input = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: null,
      };

      const result = acceptTruckRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test('C5.15: Empty string driverId is rejected', () => {
      const input = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: '',
      };

      const result = acceptTruckRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test('C5.16: Numeric driverId is rejected', () => {
      const input = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: 12345,
      };

      const result = acceptTruckRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test('C5.17: Extra unknown fields are stripped (strict Zod object)', () => {
      const input = {
        vehicleId: '550e8400-e29b-41d4-a716-446655440000',
        driverId: '660e8400-e29b-41d4-a716-446655440001',
        malicious: 'payload',
      };

      const result = acceptTruckRequestSchema.safeParse(input);
      // Zod .object() by default strips unknown keys (unlike .strict())
      if (result.success) {
        expect(result.data).not.toHaveProperty('malicious');
      }
      // If schema uses .strict(), safeParse returns false for unknown keys -- both are acceptable
    });
  });
});
