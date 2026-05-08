/**
 * =============================================================================
 * Fix B-N-13 — Outbox-leader split-key canonicalization
 * =============================================================================
 *
 * §10.B-N-13 + §1.5 Pillar-2 of /Users/nitishbhardwaj/Downloads/index-20-validated.md.
 *
 * Bug pre-fix:
 *   - Fenced acquire (`leader-election.service.ts → SET NX EX`) wrote raw `outbox:leader`.
 *   - Legacy acquire (`redisService.acquireLock(OUTBOX_LEADER_KEY, …)`) auto-prefixed `lock:`,
 *     so it wrote `lock:outbox:leader` (different physical key).
 *   - Flag flip during rolling deploy: legacy pods race for `lock:outbox:leader`,
 *     new pods race for raw `outbox:leader` → TWO leaders simultaneously for one
 *     full TTL window (60-120s) → 2× DB hammer + duplicate dispatches.
 *
 * Fix: route BOTH paths through `acquireLeader()`/`renewLeader()` from
 * `leader-election.service.ts`, which writes raw `outbox:leader` (no `lock:` prefix).
 * Any non-flag-gated `acquireLock()` call against `OUTBOX_LEADER_KEY` is gone.
 *
 * Verification at HEAD `8647f10f`:
 *   - `order-dispatch-outbox.service.ts:519` → `acquireLeader(OUTBOX_LEADER_KEY, …)` (fenced)
 *   - `order-dispatch-outbox.service.ts:544` → `acquireLeader(OUTBOX_LEADER_KEY, …)` (legacy)
 *   - No surviving `acquireLock(OUTBOX_LEADER_KEY` calls anywhere.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks — unique names: mockEval_bn13, etc.
// ---------------------------------------------------------------------------

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockIncrementCounter_bn13 = jest.fn();
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: mockIncrementCounter_bn13,
    observeHistogram: jest.fn(),
    recordHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// =============================================================================
// SOURCE-FILE CONTRACT — verify both acquire paths use the same primitive
// AND produce the same physical Redis key spelling.
// =============================================================================

const SRC_DISPATCH_PATH_bn13 = path.resolve(
  __dirname,
  '../modules/order/order-dispatch-outbox.service.ts'
);
const SRC_LEADER_HELPER_PATH_bn13 = path.resolve(
  __dirname,
  '../shared/services/leader-election.service.ts'
);

/** Strip line- and block-comments so structural regex matches only run against
 *  executable source — comments often contain `redisService.acquireLock` etc.
 *  for historical context, which would false-positive a "no acquireLock"
 *  assertion. */
function stripComments_bn13(src: string): string {
  // Remove /* … */ blocks first, then // … to end-of-line.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Fix B-N-13 — source contract: canonical leader key in dispatch outbox', () => {
  const src_bn13_raw = fs.readFileSync(SRC_DISPATCH_PATH_bn13, 'utf-8');
  const src_bn13 = stripComments_bn13(src_bn13_raw);

  it('declares OUTBOX_LEADER_KEY = "outbox:leader" (raw, no `lock:` prefix)', () => {
    expect(src_bn13).toMatch(/const\s+OUTBOX_LEADER_KEY\s*=\s*['"]outbox:leader['"]/);
    // Critical: must NOT be `lock:outbox:leader` — that is the pre-fix legacy spelling.
    expect(src_bn13).not.toMatch(/const\s+OUTBOX_LEADER_KEY\s*=\s*['"]lock:outbox:leader['"]/);
  });

  /** Find the position of the OUTER else of `if (FF_OUTBOX_LEADER_FENCING)`.
   *  We can't use the first `} else {` because the fenced branch contains a
   *  nested `} else {` (renewLeader → acquireLeader fall-through). Walk
   *  forward, tracking brace depth from the `{` of the FF_OUTBOX_LEADER_FENCING
   *  if-statement. */
  function findOuterElse_bn13(src: string): number {
    const ifIdx = src.indexOf('if (FF_OUTBOX_LEADER_FENCING)');
    if (ifIdx === -1) return -1;
    const openBrace = src.indexOf('{', ifIdx);
    if (openBrace === -1) return -1;
    let depth = 1;
    for (let i = openBrace + 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          // The matching close-brace of the FF_OUTBOX_LEADER_FENCING block.
          // The outer `} else {` starts at this position.
          return i;
        }
      }
    }
    return -1;
  }

  it('fenced path uses acquireLeader(OUTBOX_LEADER_KEY, ...) — not acquireLock', () => {
    const fencedBlockStart = src_bn13.indexOf('if (FF_OUTBOX_LEADER_FENCING)');
    expect(fencedBlockStart).toBeGreaterThan(-1);
    const outerElseIdx = findOuterElse_bn13(src_bn13);
    expect(outerElseIdx).toBeGreaterThan(fencedBlockStart);
    const fencedBlock = src_bn13.substring(fencedBlockStart, outerElseIdx);

    expect(fencedBlock).toMatch(/acquireLeader\(\s*OUTBOX_LEADER_KEY/);
    expect(fencedBlock).not.toMatch(/acquireLock\(\s*OUTBOX_LEADER_KEY/);
  });

  it('legacy path also uses acquireLeader(OUTBOX_LEADER_KEY, ...) — split-key collapsed', () => {
    const outerElseIdx = findOuterElse_bn13(src_bn13);
    expect(outerElseIdx).toBeGreaterThan(-1);

    const legacyBlock = src_bn13.substring(outerElseIdx, src_bn13.indexOf('if (!isLeader) return;', outerElseIdx));

    // Legacy block must call acquireLeader — NOT acquireLock.
    expect(legacyBlock).toMatch(/acquireLeader\(\s*OUTBOX_LEADER_KEY/);
    expect(legacyBlock).not.toMatch(/acquireLock\(\s*OUTBOX_LEADER_KEY/);
    // No live `redisService.acquireLock(` call (after comment-stripping) — that
    // is the call shape that would auto-prefix `lock:` and re-introduce the
    // split-key bug.
    expect(legacyBlock).not.toMatch(/redisService\.acquireLock\(/);
  });

  it('no surviving `acquireLock(OUTBOX_LEADER_KEY, ...)` call anywhere in dispatch outbox (post-comment-strip)', () => {
    expect(src_bn13).not.toMatch(/acquireLock\([^)]*OUTBOX_LEADER_KEY/);
    expect(src_bn13).not.toMatch(/acquireLock\(\s*['"]outbox:leader['"]/);
    expect(src_bn13).not.toMatch(/acquireLock\(\s*['"]lock:outbox:leader['"]/);
  });
});

// =============================================================================
// SOURCE-FILE CONTRACT — leader-election.service.ts writes the raw key.
// =============================================================================

describe('Fix B-N-13 — source contract: leader-election helper writes raw `outbox:leader` (no lock prefix)', () => {
  const helper_bn13_raw = fs.readFileSync(SRC_LEADER_HELPER_PATH_bn13, 'utf-8');
  const helper_bn13 = stripComments_bn13(helper_bn13_raw);

  it('acquireLeader uses raw KEYS[1] in its SET NX EX call (no `lock:${key}` template)', () => {
    // Find acquireLeader.
    const acquireIdx = helper_bn13.indexOf('export async function acquireLeader');
    expect(acquireIdx).toBeGreaterThan(-1);
    const renewIdx = helper_bn13.indexOf('export async function renewLeader', acquireIdx);
    expect(renewIdx).toBeGreaterThan(acquireIdx);
    const region = helper_bn13.substring(acquireIdx, renewIdx);

    // Critical contract: the lock helper does NOT internally prefix `lock:` —
    // callers see raw KEYS[1] from the lua script. If a future refactor wraps
    // this in `redisService.acquireLock(...)` (which auto-prefixes), B-N-13
    // would silently regress.
    expect(region).not.toMatch(/`lock:\$\{/);
    expect(region).not.toMatch(/'lock:'\s*\+/);
    expect(region).not.toMatch(/redisService\.acquireLock\(/);
  });

  it('renewLeader uses raw KEYS[1] (no `lock:` prefixing on the renewal Lua either)', () => {
    const renewIdx = helper_bn13.indexOf('export async function renewLeader');
    expect(renewIdx).toBeGreaterThan(-1);
    // Slice to end-of-function — heuristic: next `export async function` or 2000 chars.
    const nextExport = helper_bn13.indexOf('export ', renewIdx + 'export async function renewLeader'.length);
    const region = helper_bn13.substring(renewIdx, nextExport === -1 ? renewIdx + 2000 : nextExport);

    expect(region).not.toMatch(/`lock:\$\{/);
    expect(region).not.toMatch(/redisService\.acquireLock\(/);
  });
});

// =============================================================================
// RUNTIME — both branches (FF on + FF off) write to the SAME physical key.
//
// We can't easily exercise the full module-level FF toggle without
// jest.isolateModules; the source-file contract above is sufficient + load-bearing.
// This runtime test instead exercises the helper directly with an in-memory
// Redis fake and confirms ONLY one physical key shape is ever written,
// regardless of toggle path.
// =============================================================================

type StoredEntry_bn13 = { value: string; expiresAt: number };
const fakeStore_bn13 = new Map<string, StoredEntry_bn13>();

function isExpired_bn13(e: StoredEntry_bn13 | undefined): boolean {
  return !e || e.expiresAt <= Date.now();
}

const mockSetNxEx_bn13 = jest.fn(async (key: string, value: string, ttlSec: number): Promise<boolean> => {
  const existing = fakeStore_bn13.get(key);
  if (existing && !isExpired_bn13(existing)) return false;
  fakeStore_bn13.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  return true;
});

const mockEval_bn13 = jest.fn(async (script: string, keys: string[], args: string[]): Promise<any> => {
  const key = keys[0];
  const value = args[0];
  const ttlSec = parseInt(args[1], 10);
  const existing = fakeStore_bn13.get(key);
  const normalised = (script || '').replace(/\s+/g, ' ');

  if (/'NX'\s*,\s*'EX'/.test(normalised)) {
    if (existing && !isExpired_bn13(existing)) return 0;
    fakeStore_bn13.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    return 1;
  }

  if (!existing || isExpired_bn13(existing)) return 0;
  if (existing.value !== value) return 0;
  fakeStore_bn13.set(key, { value: existing.value, expiresAt: Date.now() + ttlSec * 1000 });
  return 1;
});

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    set: jest.fn(),
    setNxEx: mockSetNxEx_bn13,
    get: jest.fn(async (k: string) => fakeStore_bn13.get(k)?.value ?? null),
    del: jest.fn(async (k: string) => (fakeStore_bn13.delete(k) ? 1 : 0)),
    eval: mockEval_bn13,
    acquireLock: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const leaderModule_bn13 = require('../shared/services/leader-election.service');
const { acquireLeader: acquireLeader_bn13, renewLeader: renewLeader_bn13 } = leaderModule_bn13;

describe('Fix B-N-13 — runtime: helper writes raw `outbox:leader` (one canonical physical key)', () => {
  beforeEach(() => {
    fakeStore_bn13.clear();
    jest.clearAllMocks();
  });

  it('acquireLeader("outbox:leader", ...) writes EXACTLY `outbox:leader` — no `lock:` prefix', async () => {
    const acquired = await acquireLeader_bn13('outbox:leader', 'pod-1', 60);
    expect(acquired).toBe(true);

    // The canonical physical key landed:
    expect(fakeStore_bn13.has('outbox:leader')).toBe(true);
    // The pre-fix legacy spelling MUST NOT appear:
    expect(fakeStore_bn13.has('lock:outbox:leader')).toBe(false);
  });

  it('renewLeader extends the SAME physical key (no path divergence)', async () => {
    await acquireLeader_bn13('outbox:leader', 'pod-1', 60);
    const renewed = await renewLeader_bn13('outbox:leader', 'pod-1', 120);
    expect(renewed).toBe(true);

    expect(fakeStore_bn13.has('outbox:leader')).toBe(true);
    expect(fakeStore_bn13.has('lock:outbox:leader')).toBe(false);
  });

  it('two callers race on the SAME physical key — only one wins (no split-brain)', async () => {
    const a = await acquireLeader_bn13('outbox:leader', 'pod-1', 60);
    const b = await acquireLeader_bn13('outbox:leader', 'pod-2', 60);
    expect(a).toBe(true);
    expect(b).toBe(false);

    // Exactly one entry — pre-fix bug would have left TWO entries (one per spelling).
    expect(fakeStore_bn13.size).toBe(1);
    expect(fakeStore_bn13.get('outbox:leader')?.value).toBe('pod-1');
  });
});

export {};
