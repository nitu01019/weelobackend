/**
 * Phase 3 / Fix #3 — defineCommand-based EVALSHA via ioredis tests.
 *
 * Verifies:
 *   (a) HOT_PATH_SCRIPTS shape — 5 entries, each with name (string), numberOfKeys=1, lua (string)
 *   (b) Byte-identity — each script's Lua body matches the pre-migration literal
 *       (golden in-test fixture; weeloZremTimer is the deliberate `return`-prefix exception)
 *   (c) wireHotPathCommands wires all 5 scripts when FF=true
 *   (d) wireHotPathCommands skips when FF != "true"
 *   (e) wireHotPathCommands throws on non-empty keyPrefix
 *   (f) wireHotPathCommands skips on no-define-command client
 *   (g) assertHotPathWired throws when a method is missing
 *   (h) getScriptLua returns canonical body / throws on unknown name
 *
 * No ioredis instance is required — wireHotPathCommands accepts any
 * `defineCommand`-capable object, so a jest mock suffices.
 */

import {
  HOT_PATH_SCRIPTS,
  wireHotPathCommands,
  assertHotPathWired,
  getScriptLua,
} from '../shared/services/redis/define-commands';

const PRE_MIGRATION_BODIES: ReadonlyArray<{ name: string; lua: string }> = [
  {
    name: 'weeloGetExpiredTimers',
    // Pre-#3 literal: `return redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))`
    // Identical at HEAD redis.service.ts; #3 surfaces the `limit` arg into ARGV[2] (was hardcoded 100 at one site).
    lua: `return redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))`,
  },
  {
    name: 'weeloZremTimer',
    // Pre-#3 literal at redis.service.ts had NO return. #3 adds explicit `return` so JS sees number.
    lua: `return redis.call('zrem', KEYS[1], ARGV[1])`,
  },
  {
    name: 'weeloAcquireLock',
    lua: `
      if redis.call('exists', KEYS[1]) == 0 then
        redis.call('setex', KEYS[1], ARGV[2], ARGV[1])
        return 1
      elseif redis.call('get', KEYS[1]) == ARGV[1] then
        redis.call('expire', KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
      `,
  },
  {
    name: 'weeloReleaseLock',
    lua: `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
      `,
  },
  {
    name: 'weeloSAddWithExpire',
    lua: `
      for i = 2, #ARGV do redis.call('SADD', KEYS[1], ARGV[i]) end
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return 1
    `,
  },
];

describe('Phase-3 Fix #3 — defineCommand hot-path scripts', () => {
  describe('(a) HOT_PATH_SCRIPTS shape', () => {
    it('contains exactly 5 entries', () => {
      expect(HOT_PATH_SCRIPTS).toHaveLength(5);
    });

    it('each entry has a non-empty string name', () => {
      for (const s of HOT_PATH_SCRIPTS) {
        expect(typeof s.name).toBe('string');
        expect(s.name.length).toBeGreaterThan(0);
      }
    });

    it('each entry has numberOfKeys=1 (single-slot cluster safety)', () => {
      for (const s of HOT_PATH_SCRIPTS) {
        expect(s.numberOfKeys).toBe(1);
      }
    });

    it('each entry has a non-empty Lua body', () => {
      for (const s of HOT_PATH_SCRIPTS) {
        expect(typeof s.lua).toBe('string');
        expect(s.lua.trim().length).toBeGreaterThan(0);
      }
    });

    it('script names are unique', () => {
      const names = HOT_PATH_SCRIPTS.map(s => s.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('names include all 5 expected hot-path scripts', () => {
      const expected = [
        'weeloGetExpiredTimers',
        'weeloZremTimer',
        'weeloAcquireLock',
        'weeloReleaseLock',
        'weeloSAddWithExpire',
      ];
      const actual = HOT_PATH_SCRIPTS.map(s => s.name).sort();
      expect(actual).toEqual(expected.sort());
    });
  });

  describe('(b) byte-identity with pre-migration literals', () => {
    it('each script Lua body matches the golden in-test fixture byte-for-byte', () => {
      for (const script of HOT_PATH_SCRIPTS) {
        const fixture = PRE_MIGRATION_BODIES.find(f => f.name === script.name);
        expect(fixture).toBeDefined();
        expect(script.lua).toBe(fixture!.lua);
      }
    });

    it('weeloZremTimer starts with `return ` (Fix #3 explicit-return patch)', () => {
      const script = HOT_PATH_SCRIPTS.find(s => s.name === 'weeloZremTimer');
      expect(script).toBeDefined();
      expect(script!.lua.trim().startsWith('return ')).toBe(true);
    });
  });

  describe('(c) wireHotPathCommands — FF=true wires all scripts', () => {
    it('returns {wired: 5, skipped: null} and invokes defineCommand for each script', () => {
      const defineCommand = jest.fn();
      const client = { defineCommand, options: { keyPrefix: '' } };
      const res = wireHotPathCommands(client, { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'true' });
      expect(res).toEqual({ wired: HOT_PATH_SCRIPTS.length, skipped: null });
      expect(defineCommand).toHaveBeenCalledTimes(HOT_PATH_SCRIPTS.length);
      for (const { name, lua, numberOfKeys } of HOT_PATH_SCRIPTS) {
        expect(defineCommand).toHaveBeenCalledWith(name, { lua, numberOfKeys });
      }
    });
  });

  describe('(d) wireHotPathCommands — FF != "true" skips wiring', () => {
    it('returns {wired: 0, skipped: "feature-flag-off"} when FF=false', () => {
      const defineCommand = jest.fn();
      const res = wireHotPathCommands(
        { defineCommand },
        { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'false' },
      );
      expect(res).toEqual({ wired: 0, skipped: 'feature-flag-off' });
      expect(defineCommand).not.toHaveBeenCalled();
    });

    it('returns {wired: 0, skipped: "feature-flag-off"} when FF is undefined', () => {
      const res = wireHotPathCommands(
        { defineCommand: jest.fn() },
        {},
      );
      expect(res).toEqual({ wired: 0, skipped: 'feature-flag-off' });
    });
  });

  describe('(e) wireHotPathCommands — keyPrefix guard', () => {
    it('throws when client.options.keyPrefix is set non-empty', () => {
      const client = { defineCommand: jest.fn(), options: { keyPrefix: 'tenant:' } };
      expect(() => wireHotPathCommands(client, { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'true' }))
        .toThrow(/keyPrefix/);
    });

    it('accepts empty string keyPrefix', () => {
      const client = { defineCommand: jest.fn(), options: { keyPrefix: '' } };
      expect(() => wireHotPathCommands(client, { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'true' }))
        .not.toThrow();
    });

    it('accepts missing options.keyPrefix', () => {
      const client = { defineCommand: jest.fn() };
      expect(() => wireHotPathCommands(client, { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'true' }))
        .not.toThrow();
    });
  });

  describe('(f) wireHotPathCommands — non-ioredis client', () => {
    it('returns {wired: 0, skipped: "no-define-command"} when defineCommand is missing', () => {
      const res = wireHotPathCommands({}, { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'true' });
      expect(res).toEqual({ wired: 0, skipped: 'no-define-command' });
    });

    it('returns {wired: 0, skipped: "no-define-command"} when client is null', () => {
      const res = wireHotPathCommands(null, { FF_REDIS_DEFINE_COMMAND_HOTPATH: 'true' });
      expect(res).toEqual({ wired: 0, skipped: 'no-define-command' });
    });
  });

  describe('(g) assertHotPathWired — boot-time invariant', () => {
    it('throws when an expected method is missing', () => {
      const partial = {
        weeloGetExpiredTimers: () => {},
        weeloZremTimer: () => {},
        // missing weeloAcquireLock, weeloReleaseLock, weeloSAddWithExpire
      };
      expect(() => assertHotPathWired(partial)).toThrow(/weeloAcquireLock/);
    });

    it('does NOT throw when all methods are present', () => {
      const full: Record<string, () => void> = {};
      for (const { name } of HOT_PATH_SCRIPTS) {
        full[name] = () => {};
      }
      expect(() => assertHotPathWired(full)).not.toThrow();
    });
  });

  describe('(h) getScriptLua — body lookup', () => {
    it('returns the canonical Lua body for a known script name', () => {
      for (const script of HOT_PATH_SCRIPTS) {
        expect(getScriptLua(script.name)).toBe(script.lua);
      }
    });

    it('throws on unknown script name', () => {
      expect(() => getScriptLua('weeloDoesNotExist')).toThrow(/no hot-path script named/);
    });
  });
});
