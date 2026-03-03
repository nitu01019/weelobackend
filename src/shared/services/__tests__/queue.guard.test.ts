const waitForQueue = (ms: number = 260) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Queue broadcast inactive-order guard', () => {
  const originalEnv = { ...process.env };
  let emitToUserMock: jest.Mock;
  let findUniqueMock: jest.Mock;
  let queueService: any | null = null;

  async function loadQueueService(params: {
    failOpen: boolean;
    findUniqueImpl: (args: any) => Promise<any>;
  }): Promise<any> {
    jest.resetModules();
    emitToUserMock = jest.fn();
    findUniqueMock = jest.fn(params.findUniqueImpl);

    process.env.NODE_ENV = 'test';
    process.env.REDIS_ENABLED = 'false';
    process.env.REDIS_QUEUE_ENABLED = 'false';
    process.env.FF_CANCELLED_ORDER_QUEUE_GUARD = 'true';
    process.env.FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN = params.failOpen ? 'true' : 'false';

    jest.doMock('../socket.service', () => ({
      emitToUser: (...args: any[]) => emitToUserMock(...args)
    }));
    jest.doMock('../../database/prisma.service', () => ({
      prismaClient: {
        order: {
          findUnique: (...args: any[]) => findUniqueMock(...args)
        }
      }
    }));

    const imported = await import('../queue.service');
    queueService = imported.queueService;
    return queueService;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    if (queueService) {
      queueService.stop();
      queueService = null;
    }
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.restoreAllMocks();
    // Clear any lingering timers from queue depth samplers
    jest.useRealTimers();
  });

  it('drops stale new_broadcast when order is inactive (fail-closed)', async () => {
    const service = await loadQueueService({
      failOpen: false,
      findUniqueImpl: async () => ({ status: 'cancelled' })
    });

    await service.queueBroadcast('transporter-1', 'new_broadcast', { orderId: 'order-1' });
    await waitForQueue();

    expect(emitToUserMock).not.toHaveBeenCalled();
  });

  it('drops stale new_truck_request alias when order is inactive (fail-closed)', async () => {
    const service = await loadQueueService({
      failOpen: false,
      findUniqueImpl: async () => ({ status: 'expired' })
    });

    await service.queueBroadcast('transporter-1', 'new_truck_request', { orderId: 'order-2' });
    await waitForQueue();

    expect(emitToUserMock).not.toHaveBeenCalled();
  });

  it('emits when guard is fail-open and lookup throws', async () => {
    const service = await loadQueueService({
      failOpen: true,
      findUniqueImpl: async () => {
        throw new Error('db unavailable');
      }
    });

    await service.queueBroadcast('transporter-1', 'new_broadcast', { orderId: 'order-3' });
    await waitForQueue();

    expect(emitToUserMock).toHaveBeenCalledWith(
      'transporter-1',
      'new_broadcast',
      expect.objectContaining({ orderId: 'order-3' })
    );
  });
});
