/**
 * =============================================================================
 * F-B-06 companion — redisCache fail-open wrapper
 * =============================================================================
 *
 * Verifies the cache-aside contract: every READ path returns null on
 * underlying error (caller proceeds to DB fallback), every WRITE path
 * propagates the error so a silent write is never masked.
 * =============================================================================
 */

const mockGet = jest.fn();
const mockGetJSON = jest.fn();
const mockSet = jest.fn();
const mockSetJSON = jest.fn();
const mockDel = jest.fn();
const mockExists = jest.fn();
const mockIncrement = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockGet(...args),
    getJSON: (...args: any[]) => mockGetJSON(...args),
    set: (...args: any[]) => mockSet(...args),
    setJSON: (...args: any[]) => mockSetJSON(...args),
    del: (...args: any[]) => mockDel(...args),
    exists: (...args: any[]) => mockExists(...args),
  },
}));

jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: { incrementCounter: (...a: any[]) => mockIncrement(...a) },
}));

import { redisCache } from '../shared/services/redis-cache.service';

beforeEach(() => {
  mockGet.mockReset();
  mockGetJSON.mockReset();
  mockSet.mockReset();
  mockSetJSON.mockReset();
  mockDel.mockReset();
  mockExists.mockReset();
  mockIncrement.mockReset();
});

describe('F-B-06 redisCache fail-open', () => {
  describe('read paths swallow errors, return null, bump miss counter', () => {
    it('get: returns null when transport throws + increments counter', async () => {
      mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
      const out = await redisCache.get('fleet:x');
      expect(out).toBeNull();
      expect(mockIncrement).toHaveBeenCalledWith('redis_cache_miss_total', { reason: 'get_error' });
    });

    it('get: passes through value on success', async () => {
      mockGet.mockResolvedValue('hello');
      const out = await redisCache.get('key');
      expect(out).toBe('hello');
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('getJSON: returns null on transport error', async () => {
      mockGetJSON.mockRejectedValue(new Error('ETIMEDOUT'));
      const out = await redisCache.getJSON<{ x: number }>('j');
      expect(out).toBeNull();
      expect(mockIncrement).toHaveBeenCalledWith('redis_cache_miss_total', { reason: 'getJSON_error' });
    });

    it('getJSON: returns parsed object on success', async () => {
      mockGetJSON.mockResolvedValue({ x: 1 });
      const out = await redisCache.getJSON<{ x: number }>('j');
      expect(out).toEqual({ x: 1 });
    });

    it('del: returns false on transport error (non-critical)', async () => {
      mockDel.mockRejectedValue(new Error('boom'));
      const out = await redisCache.del('k');
      expect(out).toBe(false);
    });

    it('del: passes through on success', async () => {
      mockDel.mockResolvedValue(true);
      const out = await redisCache.del('k');
      expect(out).toBe(true);
    });

    it('exists: returns false on transport error', async () => {
      mockExists.mockRejectedValue(new Error('boom'));
      const out = await redisCache.exists('k');
      expect(out).toBe(false);
    });

    it('exists: returns true on success', async () => {
      mockExists.mockResolvedValue(true);
      const out = await redisCache.exists('k');
      expect(out).toBe(true);
    });
  });

  describe('write paths surface errors (no silent-write masking)', () => {
    it('set: rethrows on transport failure', async () => {
      mockSet.mockRejectedValue(new Error('EAGAIN'));
      await expect(redisCache.set('k', 'v', 10)).rejects.toThrow('EAGAIN');
    });

    it('set: passes args through to redisService', async () => {
      mockSet.mockResolvedValue(undefined);
      await redisCache.set('k', 'v', 30);
      expect(mockSet).toHaveBeenCalledWith('k', 'v', 30);
    });

    it('setJSON: rethrows on transport failure', async () => {
      mockSetJSON.mockRejectedValue(new Error('OOM'));
      await expect(redisCache.setJSON('k', { x: 1 }, 10)).rejects.toThrow('OOM');
    });

    it('setJSON: passes args through to redisService', async () => {
      mockSetJSON.mockResolvedValue(undefined);
      await redisCache.setJSON('k', { a: 1 }, 60);
      expect(mockSetJSON).toHaveBeenCalledWith('k', { a: 1 }, 60);
    });
  });
});
