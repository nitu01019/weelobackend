// src/shared/services/redis/define-commands.ts
//
// Hot-path Lua scripts registered via ioredis `defineCommand` to use EVALSHA
// on the wire. Public API only — no reads of `client.scriptsSet`, no custom
// sentinels written to the client object.
//
// ioredis contract (https://github.com/redis/ioredis README §"Lua Scripting",
// verified against 5.9.2 source):
//   1. `defineCommand` is sync (Commander.js:46-50).
//   2. `client.<name>(...)` routes through `Script.execute → EVALSHA` with
//      transparent `NOSCRIPT → EVAL → EVALSHA` recovery per connection
//      (Script.js:14-34, :48-57).
//   3. Re-defining an existing name overwrites silently (Commander.js:46-50);
//      safe to call across reconnects.
//
// Cluster safety: every script has `numberOfKeys=1`, so all keys hash to a
// single slot. (https://github.com/redis/ioredis README §"Cluster".)
//
// Scope of wiring (defensive notes):
//   - Only the main `client` is wired. `subscriber` and `blockingClient` are
//     pub/sub / BRPOP-only and never send Lua at HEAD. Adding Lua via either
//     in the future REQUIRES wiring those clients here.
//   - `enableAutoPipelining` is `false` at HEAD. If ever enabled, pipelines
//     capture `scriptsSet` at construction (Pipeline.js:38-43), so wiring MUST
//     happen before any pipeline is built — guarded by Step 5 invariant.
//   - `keyPrefix` is asserted falsy at wire time. The named-method path does
//     NOT auto-apply client.options.keyPrefix the same way plain `client.eval`
//     does, so silent multi-tenant crossover is blocked.

export interface DefinedScript {
  readonly name: string;
  readonly numberOfKeys: 1;
  readonly lua: string;
}

/**
 * Lua bodies. Each body is byte-identical to the literal it replaces at HEAD
 * `7bc3b3d6`, EXCEPT `weeloZremTimer` which adds an explicit `return` (the
 * original literal had no return, so the type signature `Promise<number>` was
 * a lie). The new body's SHA1 differs from the un-`return`ed form, but the
 * script is net-new on the wire — no production cache invalidation, only a
 * one-time `EVAL` per socket.
 *
 * EDIT WITH CAUTION — single-byte changes alter the SHA. Use the golden-file
 * fixture in `__fixtures__/lua-bodies-pre-migration.json` to detect drift.
 */
export const HOT_PATH_SCRIPTS: ReadonlyArray<DefinedScript> = [
  // (1) Timer poller — every 2s × 7 prefixes × 4 pods ≈ 14 calls/s.
  {
    name: 'weeloGetExpiredTimers',
    numberOfKeys: 1,
    lua: `return redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))`,
  },

  // (2) Timer cleanup — 1:1 with poller; cancelTimer adds spikes.
  // PATCHED: original literal at HEAD redis.service.ts had no `return`.
  // Lua returns nil → JS null → signature `Promise<number>` was wrong.
  {
    name: 'weeloZremTimer',
    numberOfKeys: 1,
    lua: `return redis.call('zrem', KEYS[1], ARGV[1])`,
  },

  // (3) Distributed lock acquire — Redlock-style; ~100 RPS sustained.
  // Byte-identical to redis.service.ts acquireLockOnce Lua body.
  {
    name: 'weeloAcquireLock',
    numberOfKeys: 1,
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

  // (4) Distributed lock release — 1:1 with acquireLock.
  // Byte-identical to redis.service.ts releaseLock Lua body.
  {
    name: 'weeloReleaseLock',
    numberOfKeys: 1,
    lua: `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
      `,
  },

  // (5) Atomic SADD + EXPIRE — per broadcast-notify fan-out.
  // Byte-identical to RealRedisClient.sAddWithExpire Lua body.
  {
    name: 'weeloSAddWithExpire',
    numberOfKeys: 1,
    lua: `
      for i = 2, #ARGV do redis.call('SADD', KEYS[1], ARGV[i]) end
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return 1
    `,
  },
];

export interface IoredisWithHotPathScripts {
  weeloGetExpiredTimers(key: string, nowMs: string, limit: string): Promise<string[] | null>;
  /** Returns count of members removed (0 or 1). */
  weeloZremTimer(key: string, member: string): Promise<number>;
  weeloAcquireLock(key: string, holderId: string, ttlSec: string): Promise<0 | 1>;
  weeloReleaseLock(key: string, holderId: string): Promise<number>;
  weeloSAddWithExpire(key: string, ttlSec: string, ...members: string[]): Promise<number>;
}

interface DefineCommandCapable {
  defineCommand(name: string, definition: { lua: string; numberOfKeys?: number }): void;
  options?: { keyPrefix?: string };
}

function hasDefineCommand(client: unknown): client is DefineCommandCapable {
  return (
    !!client &&
    typeof (client as { defineCommand?: unknown }).defineCommand === 'function'
  );
}

export type WireSkipReason = 'no-define-command' | 'feature-flag-off';

export interface WireResult {
  readonly wired: number;
  readonly skipped: WireSkipReason | null;
}

/**
 * Wire all hot-path scripts onto an ioredis client. Idempotent (ioredis
 * silently overwrites duplicates per Commander.js:46-50).
 *
 * @throws if `client.options.keyPrefix` is set non-empty — named-method path
 *         does not propagate keyPrefix the same way plain EVAL does, so a
 *         silent multi-tenant crossover would result.
 */
export function wireHotPathCommands(
  client: unknown,
  env: { FF_REDIS_DEFINE_COMMAND_HOTPATH?: string } = {
    FF_REDIS_DEFINE_COMMAND_HOTPATH: process.env.FF_REDIS_DEFINE_COMMAND_HOTPATH,
  },
): WireResult {
  if (env.FF_REDIS_DEFINE_COMMAND_HOTPATH !== 'true') {
    return { wired: 0, skipped: 'feature-flag-off' };
  }
  if (!hasDefineCommand(client)) {
    return { wired: 0, skipped: 'no-define-command' };
  }

  const keyPrefix = client.options?.keyPrefix;
  if (typeof keyPrefix === 'string' && keyPrefix.length > 0) {
    throw new Error(
      `[define-commands] client.options.keyPrefix=${JSON.stringify(keyPrefix)} ` +
      `is set. Named-method scripts do not auto-prepend keyPrefix. Either ` +
      `unset keyPrefix or migrate the hot-path scripts to keyPrefix-aware form.`,
    );
  }

  for (const { name, numberOfKeys, lua } of HOT_PATH_SCRIPTS) {
    client.defineCommand(name, { lua, numberOfKeys });
  }
  return { wired: HOT_PATH_SCRIPTS.length, skipped: null };
}

/**
 * Post-wire boot assertion. Run AFTER `wireHotPathCommands` returns
 * `skipped===null`. Fails loudly if any expected method is missing.
 */
export function assertHotPathWired(
  client: unknown,
): asserts client is IoredisWithHotPathScripts {
  for (const { name } of HOT_PATH_SCRIPTS) {
    const fn = (client as Record<string, unknown>)[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `[define-commands] hot-path command not wired: ${name}. ` +
        `wireHotPathCommands must be called before assertHotPathWired.`,
      );
    }
  }
}

/**
 * Look up the canonical Lua body for a registered script. Used by
 * `*OrFallback` wrappers when `hotPathCmds === null` (FF-off, dev-mode).
 */
export function getScriptLua(name: string): string {
  const script = HOT_PATH_SCRIPTS.find(s => s.name === name);
  if (!script) {
    throw new Error(`[define-commands] no hot-path script named: ${name}`);
  }
  return script.lua;
}
