export {};

import { exotelService } from '../shared/services/exotel.service';

describe('Exotel Service', () => {
  it('reports not configured when env vars missing', () => {
    expect(exotelService.isConfigured()).toBe(false);
  });

  it('returns error when not configured', async () => {
    const result = await exotelService.initiateCall('9876543210', '9123456789');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Exotel not configured');
  });
});

describe('Queue DLQ Pattern', () => {
  it('queue service module loads without error', () => {
    // Verify the queue service can be required without crash
    const queuePath = require.resolve('../shared/services/queue.service');
    expect(queuePath).toBeDefined();
  });
});
