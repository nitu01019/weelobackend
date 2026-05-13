import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

/**
 * Fix #25 + #30 — migrate_with_retry harness + emit_migration_metric tests.
 *
 * Strategy:
 *   1. Read scripts/docker-entrypoint.sh and extract the migrate_with_retry
 *      function body (between `migrate_with_retry() {` and its closing `}`).
 *   2. Write the extracted block to /tmp/test-<random>/migrate-fn.sh with the
 *      env-var hook defaults prepended.
 *   3. For each test case, build a per-test tempdir containing:
 *        - bin/npx        (stub: exit-code + stdout controlled per case)
 *        - bin/stub-aws   (records "$@" to ./aws-calls.log)
 *   4. Run bash -c "PATH=<tempbin>:$PATH AWS_CLI=stub-aws SLEEP_FN=: RAND_FN=__rand_zero \
 *      DATE_FN=date  source migrate-fn.sh && migrate_with_retry" with FF set per case.
 *   5. Assert: exit code, stdout log-oracles, aws-calls.log emissions.
 *
 * NOTE: scripts/docker-entrypoint.sh uses `#!/bin/sh`, but the test invokes bash
 * explicitly because the function uses `local` (an ash/bash extension; POSIX sh
 * does not define it). On Alpine prod the shebang is /bin/sh -> busybox ash
 * which supports `local`. macOS /bin/bash also supports `local`. Test uses
 * /bin/bash so the same function code runs identically.
 */

const repoRoot = path.resolve(__dirname, '../..');
const entrypointPath = path.join(repoRoot, 'scripts/docker-entrypoint.sh');

function extractFunction(src: string, name: string): string {
  const startRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const startMatch = src.match(startRe);
  if (!startMatch || startMatch.index === undefined) {
    throw new Error(`function ${name} not found in entrypoint`);
  }
  // Walk braces from the opening { to find matching close.
  let depth = 0;
  let i = src.indexOf('{', startMatch.index);
  const fnStart = startMatch.index;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(fnStart, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

function makeTempdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
}

interface NpxStubOpts {
  exitCodes: number[]; // exit code per invocation, then last is repeated
  stdouts: string[]; // stdout per invocation, then last is repeated
}

function writeStubs(dir: string, npx: NpxStubOpts): {
  binDir: string;
  awsLog: string;
  counterFile: string;
} {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const counterFile = path.join(dir, 'npx-count');
  fs.writeFileSync(counterFile, '0\n');

  // Build a per-invocation dispatch for npx stub.
  // Reads/increments counterFile; emits stdouts[i] and exits exitCodes[i] (clamped to last).
  const exitArr = npx.exitCodes.map((c) => String(c)).join(' ');
  const stdoutArr = npx.stdouts.map((s) => `'${s.replace(/'/g, `'\\''`)}'`).join(' ');
  const npxScript = `#!/bin/bash
# Stub npx. Per-invocation dispatch via counter file.
COUNTER_FILE="${counterFile}"
EXITS=(${exitArr})
STDOUTS=(${stdoutArr})
n=$(cat "$COUNTER_FILE")
n=$((n + 0))
idx=$n
if [ $idx -ge \${#EXITS[@]} ]; then idx=$((\${#EXITS[@]} - 1)); fi
echo $((n + 1)) > "$COUNTER_FILE"
printf '%s\\n' "\${STDOUTS[$idx]}"
exit "\${EXITS[$idx]}"
`;
  fs.writeFileSync(path.join(binDir, 'npx'), npxScript, { mode: 0o755 });

  const awsLog = path.join(dir, 'aws-calls.log');
  fs.writeFileSync(awsLog, '');
  const awsScript = `#!/bin/bash
# Stub aws CLI. Records full argv (newline-separated) to aws-calls.log.
printf '%s\\n' "$@" >> "${awsLog}"
printf -- '---END---\\n' >> "${awsLog}"
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'stub-aws'), awsScript, { mode: 0o755 });

  return { binDir, awsLog, counterFile };
}

function buildHarnessScript(dir: string, fnBody: string): string {
  // Prepend env-var hook defaults + __rand_zero override, then the function body.
  const hooksAndFn = `#!/bin/bash
set -o pipefail
: "\${SLEEP_FN:=sleep}"
: "\${AWS_CLI:=aws}"
: "\${RAND_FN:=__rand_default}"
: "\${DATE_FN:=date}"
__rand_default() { echo "$((RANDOM % 3))"; }
__rand_zero() { echo 0; }

${fnBody}

migrate_with_retry
exit $?
`;
  const harnessPath = path.join(dir, 'harness.sh');
  fs.writeFileSync(harnessPath, hooksAndFn, { mode: 0o755 });
  return harnessPath;
}

function readAwsCalls(awsLog: string): string[][] {
  if (!fs.existsSync(awsLog)) return [];
  const raw = fs.readFileSync(awsLog, 'utf8');
  if (!raw.trim()) return [];
  // Split by ---END--- marker (recorded by stub-aws after each invocation).
  return raw
    .split(/^---END---$/m)
    .map((chunk) => chunk.split('\n').filter((s) => s !== ''))
    .filter((argv) => argv.length > 0);
}

describe('Fix #25 + #30 — migrate_with_retry harness', () => {
  const entrypointSrc = fs.readFileSync(entrypointPath, 'utf8');
  const fnBody = extractFunction(entrypointSrc, 'migrate_with_retry');

  function runHarness(
    env: Record<string, string>,
    npxStub: NpxStubOpts,
  ): { dir: string; status: number; stdout: string; stderr: string; awsLog: string } {
    const dir = makeTempdir();
    const { binDir, awsLog } = writeStubs(dir, npxStub);
    const harnessPath = buildHarnessScript(dir, fnBody);

    const childEnv: Record<string, string> = {
      PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      AWS_CLI: 'stub-aws',
      SLEEP_FN: ':', // no-op for tests
      RAND_FN: '__rand_zero',
      DATE_FN: 'date',
      AWS_REGION: 'ap-south-1',
      ...env,
    };

    const result = spawnSync('/bin/bash', [harnessPath], {
      env: childEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      dir,
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      awsLog,
    };
  }

  afterEach(() => {
    // Best-effort cleanup; ignore failures.
    // The tempdir name pattern means /tmp/migrate-test-* — only remove those.
    try {
      const entries = fs.readdirSync(os.tmpdir());
      for (const e of entries) {
        if (e.startsWith('migrate-test-')) {
          fs.rmSync(path.join(os.tmpdir(), e), { recursive: true, force: true });
        }
      }
    } catch {
      // ignore
    }
  });

  test('(1) FF=true, npx succeeds first attempt → success attempt=1, 1 success emit', () => {
    const r = runHarness(
      { FF_MIGRATION_RETRY_HARNESS_ENABLED: 'true' },
      { exitCodes: [0], stdouts: ['migrations applied'] },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[MIGRATE\] success attempt=1/);
    const calls = readAwsCalls(r.awsLog);
    expect(calls.length).toBe(1);
    // First call should emit migration_status with result=success.
    const argvJoined = calls[0].join(' ');
    expect(argvJoined).toMatch(/--metric-name\s+migration_status/);
    expect(argvJoined).toMatch(/result=success/);
  });

  test('(2) FF=true, npx fails with 55P03 then succeeds → retry then success', () => {
    const r = runHarness(
      { FF_MIGRATION_RETRY_HARNESS_ENABLED: 'true' },
      {
        exitCodes: [1, 0],
        stdouts: [
          'ERROR: P3009 55P03 lock_not_available — could not acquire lock',
          'migrations applied',
        ],
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[MIGRATE\] retry attempt=1 reason=lock_not_available/);
    expect(r.stdout).toMatch(/\[MIGRATE\] success attempt=2/);
    const calls = readAwsCalls(r.awsLog);
    // 1 retry emit (lock_not_available_total) + 1 success emit (status).
    expect(calls.length).toBe(2);
    expect(calls[0].join(' ')).toMatch(/migration_lock_not_available_total/);
    expect(calls[1].join(' ')).toMatch(/migration_status/);
    expect(calls[1].join(' ')).toMatch(/result=success/);
  });

  test('(3) FF=false → harness disabled, exit 0, zero AWS_CLI calls', () => {
    const r = runHarness(
      { FF_MIGRATION_RETRY_HARNESS_ENABLED: 'false' },
      { exitCodes: [0], stdouts: ['unused — npx must not be invoked'] },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[MIGRATE\] harness disabled/);
    const calls = readAwsCalls(r.awsLog);
    expect(calls.length).toBe(0);
  });

  test('(4) FF=true, non-lock error → fail attempt=1 reason=non_lock_error, exit 1', () => {
    const r = runHarness(
      { FF_MIGRATION_RETRY_HARNESS_ENABLED: 'true' },
      {
        exitCodes: [1],
        stdouts: ['ERROR: P3005 database schema is not empty — non-retryable'],
      },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[MIGRATE\] fail attempt=1 reason=non_lock_error/);
    const calls = readAwsCalls(r.awsLog);
    // No emit on non-lock error path.
    expect(calls.length).toBe(0);
  });

  test('(5) FF=true, always 55P03 → giveup attempts=5, exit 1, 5 lock-not-available emits', () => {
    const r = runHarness(
      { FF_MIGRATION_RETRY_HARNESS_ENABLED: 'true' },
      {
        exitCodes: [1, 1, 1, 1, 1],
        stdouts: [
          'ERROR: 55P03 lock_not_available 1',
          'ERROR: 55P03 lock_not_available 2',
          'ERROR: 55P03 lock_not_available 3',
          'ERROR: 55P03 lock_not_available 4',
          'ERROR: 55P03 lock_not_available 5',
        ],
      },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[MIGRATE\] giveup attempts=5/);
    const calls = readAwsCalls(r.awsLog);
    // 5 retry emits (one per failed attempt where 55P03 matched), zero success emits.
    const lockCalls = calls.filter((c) =>
      c.join(' ').includes('migration_lock_not_available_total'),
    );
    expect(lockCalls.length).toBe(5);
    const successCalls = calls.filter((c) => c.join(' ').includes('result=success'));
    expect(successCalls.length).toBe(0);
  });
});
