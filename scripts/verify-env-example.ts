#!/usr/bin/env ts-node
/**
 * =============================================================================
 * F-C-75 — verify-env-example.ts
 * =============================================================================
 *
 * CI drift lint that guarantees `.env.example` stays in sync with the Zod-style
 * declarations in `src/core/config/env.validation.ts`.
 *
 * Industry pattern: env_lint / dotenv-safe. Every env key a developer sees in
 * the validator MUST be documented in `.env.example` so new devs can copy the
 * file and run locally. CI-side enforcement prevents silent drift.
 *
 * Usage:
 *   npm run lint:env
 *
 * Exit codes:
 *   0  — every declared key has a `.env.example` entry
 *   1  — one or more declared keys are missing (or syntax error)
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const ENV_VALIDATION_PATH = path.join(REPO_ROOT, 'src', 'core', 'config', 'env.validation.ts');

// ---------------------------------------------------------------------------
// Parsing helpers — intentionally regex-based to avoid pulling AST deps in CI
// ---------------------------------------------------------------------------

/**
 * Parse `.env.example` into the set of declared keys.
 * Ignores comments and blank lines. Supports `KEY=value` and `KEY=`.
 */
function parseEnvExampleKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // KEY=...  (KEY = [A-Z0-9_]+)
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match && match[1]) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Extract every `name: 'KEY_NAME'` declared inside the ENV_VARS array.
 * This is a narrow regex match — we deliberately only look at the
 * `name: '...'` pattern used by the EnvVar interface, which is the
 * single way keys are declared in env.validation.ts.
 */
function parseDeclaredEnvKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const regex = /name:\s*'([A-Z][A-Z0-9_]*)'/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    keys.add(m[1]!);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Lint entry-point
// ---------------------------------------------------------------------------

interface LintResult {
  readonly missing: readonly string[];
  readonly declaredCount: number;
  readonly exampleCount: number;
}

export function lintEnvExample(opts?: {
  envExamplePath?: string;
  envValidationPath?: string;
}): LintResult {
  const envExamplePath = opts?.envExamplePath ?? ENV_EXAMPLE_PATH;
  const envValidationPath = opts?.envValidationPath ?? ENV_VALIDATION_PATH;

  if (!fs.existsSync(envExamplePath)) {
    throw new Error(`.env.example not found at ${envExamplePath}`);
  }
  if (!fs.existsSync(envValidationPath)) {
    throw new Error(`env.validation.ts not found at ${envValidationPath}`);
  }

  const exampleText = fs.readFileSync(envExamplePath, 'utf-8');
  const validationText = fs.readFileSync(envValidationPath, 'utf-8');

  const exampleKeys = parseEnvExampleKeys(exampleText);
  const declaredKeys = parseDeclaredEnvKeys(validationText);

  const missing: string[] = [];
  for (const key of declaredKeys) {
    if (!exampleKeys.has(key)) {
      missing.push(key);
    }
  }
  missing.sort();

  return {
    missing,
    declaredCount: declaredKeys.size,
    exampleCount: exampleKeys.size,
  };
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

function main(): void {
  let result: LintResult;
  try {
    // Test hook: allow overriding the .env.example path via env var so
    // integration tests can produce a synthetic drift without touching
    // the real file. Never set in production/CI.
    const envExamplePath = process.env.ENV_EXAMPLE_PATH_OVERRIDE;
    result = lintEnvExample(envExamplePath ? { envExamplePath } : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[verify-env-example] FAILED: ${msg}\n`);
    process.exit(1);
    return;
  }

  if (result.missing.length === 0) {
    process.stdout.write(
      `[verify-env-example] OK — ${result.declaredCount} declared keys covered by ${result.exampleCount} .env.example entries.\n`
    );
    process.exit(0);
    return;
  }

  process.stderr.write(
    `[verify-env-example] FAIL — the following env.validation.ts keys are missing from .env.example:\n`
  );
  for (const key of result.missing) {
    process.stderr.write(`  - ${key}\n`);
  }
  process.stderr.write(
    `\nAdd each missing KEY=<default> line to .env.example so the setup doc stays authoritative.\n`
  );
  process.exit(1);
}

// Only run main when invoked directly (not when imported by tests)
if (require.main === module) {
  main();
}
