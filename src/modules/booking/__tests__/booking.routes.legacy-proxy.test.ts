describe('booking routes legacy proxy -> canonical order flow', () => {
  const originalEnv = { ...process.env };

  const mockCreateOrder = jest.fn();
  const mockCreateBooking = jest.fn();

  const buildReq = () => ({
    user: {
      userId: 'cust-1',
      phone: '9999999999',
      role: 'customer'
    },
    body: {
      pickup: {
        latitude: 12.9716,
        longitude: 77.5946,
        address: 'Pickup Point',
        city: 'Bengaluru'
      },
      drop: {
        latitude: 12.9352,
        longitude: 77.6245,
        address: 'Drop Point',
        city: 'Bengaluru'
      },
      vehicleType: 'open',
      vehicleSubtype: '17ft',
      trucksNeeded: 2,
      distanceKm: 12,
      pricePerTruck: 1200,
      goodsType: 'Electronics'
    },
    headers: {
      'x-idempotency-key': 'idem-1'
    }
  }) as any;

  const buildRes = () => {
    const headers: Record<string, string> = {};
    const res: any = {
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      status: jest.fn(function status(this: any) { return this; }),
      json: jest.fn()
    };
    return { res, headers };
  };

  const canonicalResult = {
    orderId: 'ord-1',
    totalTrucks: 2,
    totalAmount: 2400,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    expiresIn: 120,
    truckRequests: [{
      id: 'req-1',
      vehicleType: 'open',
      vehicleSubtype: '17ft',
      quantity: 2,
      pricePerTruck: 1200,
      matchingTransporters: 5
    }]
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      FF_LEGACY_BOOKING_PROXY_TO_ORDER: 'true'
    };

    jest.doMock('../../../shared/middleware/auth.middleware', () => ({
      authMiddleware: (_req: any, _res: any, next: any) => next(),
      roleGuard: () => (_req: any, _res: any, next: any) => next()
    }));

    jest.doMock('../../../shared/utils/validation.utils', () => {
      const actual = jest.requireActual('../../../shared/utils/validation.utils');
      return {
        ...actual,
        validateRequest: () => (_req: any, _res: any, next: any) => next()
      };
    });

    jest.doMock('../booking.service', () => ({
      bookingService: {
        createBooking: (...args: any[]) => mockCreateBooking(...args)
      }
    }));

    jest.doMock('../../order/order.service', () => ({
      orderService: {
        createOrder: (...args: any[]) => mockCreateOrder(...args),
        checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
        getCustomerOrders: jest.fn(),
        getOrderById: jest.fn(),
        getOrderWithRequests: jest.fn(),
        cancelOrder: jest.fn(),
        getOrderDetails: jest.fn(),
        getActiveTruckRequestsForTransporter: jest.fn(),
        acceptTruckRequest: jest.fn(),
      }
    }));

    jest.doMock('../../../shared/services/redis.service', () => ({
      redisService: {
        acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      }
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses canonical order service and preserves compatibility headers for POST /bookings', async () => {
    mockCreateOrder.mockResolvedValue(canonicalResult);

    const { bookingRouter } = await import('../booking.routes');
    const postRootLayer = (bookingRouter as any).stack.find(
      (layer: any) => layer.route?.path === '/' && layer.route.methods?.post
    );
    expect(postRootLayer).toBeDefined();

    const handler = postRootLayer.route.stack[postRootLayer.route.stack.length - 1].handle;
    const req = buildReq();
    const { res, headers } = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(headers['X-Weelo-Legacy-Proxy']).toBe('true');
    expect(headers['X-Weelo-Canonical-Path']).toBe('/api/v1/orders');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          booking: expect.objectContaining({
            id: canonicalResult.orderId,
            vehicleType: 'open',
            vehicleSubtype: '17ft',
            trucksNeeded: 2
          })
        })
      })
    );
  });
});
