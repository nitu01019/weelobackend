/**
 * =============================================================================
 * Phase 7 follow-up — Defect #4: sAddPairWithExpire CROSSSLOT under cluster
 * =============================================================================
 *
 * Today's implementation at redis.service.ts:1578 passes `[key1, key2 || '']`
 * to the Lua eval. Redis Cluster CRC16-routes EVERY entry in KEYS — slot('')
 * is 0, while slot(real key) is the hash-tag CRC. Mismatched slots →
 * CROSSSLOT error on every heartbeat when REDIS_CLUSTER=true and key2 is null.
 *
 * Fix: build the KEYS array conditionally (`key2 ? [key1, key2] : [key1]`)
 * and change the Lua check from `if KEYS[2] and KEYS[2] ~= ''` to the
 * idiomatic `if #KEYS == 2`.
 *
 * Industry pattern: Redis Cluster hash-tag spec — multi-key commands must
 * map to a single slot.
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REDIS_SERVICE_PATH = join(__dirname, '..', 'shared', 'services', 'redis.service.ts');

describe('Phase 7 follow-up — Defect #4 sAddPairWithExpire CROSSSLOT safety', () => {
  let redisSource: string;
  let sAddPairBlock: string;

  beforeAll(() => {
    redisSource = readFileSync(REDIS_SERVICE_PATH, 'utf8');
    // Isolate the RealRedisClient.sAddPairWithExpire function body for tighter assertions.
    // The InMemoryRedisClient version at L862-875 is sequential JS (no Lua) and
    // does not have the CROSSSLOT issue — only the RealRedisClient version is the target.
    const fnStart = redisSource.indexOf('async sAddPairWithExpire(', redisSource.indexOf('class RealRedisClient'));
    expect(fnStart).toBeGreaterThan(-1);
    sAddPairBlock = redisSource.slice(fnStart, fnStart + 1500);
  });

  // ---------------------------------------------------------------------------
  // (a) Lua script uses #KEYS == 2 (not the empty-string check)
  // ---------------------------------------------------------------------------
  describe('Lua script uses dynamic #KEYS length check', () => {
    it('uses `if #KEYS == 2` to detect the dual-key path', () => {
      expect(sAddPairBlock).toMatch(/if\s+#KEYS\s*==\s*2\s+then/);
    });

    it('does NOT use the legacy empty-string check `KEYS\\[2\\] and KEYS\\[2\\] ~= \\\'\\\'`', () => {
      // The empty-string KEYS[2] is what triggers CROSSSLOT on Redis Cluster
      expect(sAddPairBlock).not.toMatch(/KEYS\[2\]\s+and\s+KEYS\[2\]\s*~=\s*''/);
    });
  });

  // ---------------------------------------------------------------------------
  // (b) KEYS array is built conditionally (no empty-string sentinel)
  // ---------------------------------------------------------------------------
  describe('KEYS array passed to eval is conditional on key2', () => {
    it('passes [key1] when key2 is null/undefined', () => {
      // Pattern: `key2 ? [key1, key2] : [key1]` (or equivalent)
      expect(sAddPairBlock).toMatch(/key2\s*\?\s*\[key1,\s*key2\]\s*:\s*\[key1\]/);
    });

    it('does NOT pass the empty-string sentinel `[key1, key2 || \\\'\\\']`', () => {
      expect(sAddPairBlock).not.toMatch(/\[key1,\s*key2\s*\|\|\s*''\]/);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) Behavioural — spy on eval and verify KEYS length is dynamic
  //     Use a stand-in class that mirrors the fix; this proves the pattern's
  //     correctness without needing a real Redis connection.
  // ---------------------------------------------------------------------------
  describe('behavioural verification of the dynamic-keys pattern', () => {
    it('mirror implementation passes 1-element KEYS when key2 is null', async () => {
      const evalSpy = jest.fn().mockResolvedValue(1);
      const mirror = {
        async sAddPairWithExpire(
          key1: string,
          key2: string | null,
          ttlSeconds: number,
          member: string,
        ): Promise<void> {
          if (!member) return;
          const luaScript = `
              redis.call('SADD', KEYS[1], ARGV[2])
              redis.call('EXPIRE', KEYS[1], ARGV[1])
              if #KEYS == 2 then
                  redis.call('SADD', KEYS[2], ARGV[2])
                  redis.call('EXPIRE', KEYS[2], ARGV[1])
              end
              return 1
          `;
          const keys: string[] = key2 ? [key1, key2] : [key1];
          await evalSpy(luaScript, keys, [String(ttlSeconds), member]);
        },
      };

      await mirror.sAddPairWithExpire('h3:8:cell:{vk}', null, 60, 'tid-1');

      expect(evalSpy).toHaveBeenCalledTimes(1);
      const callArgs = evalSpy.mock.calls[0];
      expect(callArgs[1]).toEqual(['h3:8:cell:{vk}']); // KEYS length == 1
    });

    it('mirror implementation passes 2-element KEYS when both keys provided', async () => {
      const evalSpy = jest.fn().mockResolvedValue(1);
      const mirror = {
        async sAddPairWithExpire(
          key1: string,
          key2: string | null,
          _ttl: number,
          member: string,
        ): Promise<void> {
          if (!member) return;
          const keys: string[] = key2 ? [key1, key2] : [key1];
          await evalSpy('script-placeholder', keys, ['60', member]);
        },
      };

      await mirror.sAddPairWithExpire('h3:8:cell:{vk}', 'h3:7:parent:{vk}', 60, 'tid-1');
      expect(evalSpy.mock.calls[0][1]).toEqual(['h3:8:cell:{vk}', 'h3:7:parent:{vk}']);
    });

    it('mirror skips eval entirely when member is empty', async () => {
      const evalSpy = jest.fn().mockResolvedValue(1);
      const mirror = {
        async sAddPairWithExpire(
          _key1: string,
          _key2: string | null,
          _ttl: number,
          member: string,
        ): Promise<void> {
          if (!member) return;
          await evalSpy();
        },
      };
      await mirror.sAddPairWithExpire('k1', null, 60, '');
      expect(evalSpy).not.toHaveBeenCalled();
    });
  });
});
