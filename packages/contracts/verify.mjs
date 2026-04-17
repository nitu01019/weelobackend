#!/usr/bin/env node
/**
 * F-C-52 · CI drift guard (advisory mode; `--strict` fails the build)
 *
 * Two invariants asserted:
 *   1. Regenerating from YAML/proto produces byte-identical generated files
 *      (codegen is deterministic; devs must commit their regen).
 *   2. No file outside packages/contracts hand-rolls an `export const SocketEvent = { ... }`
 *      literal registry. This mirrors src/__tests__/contracts-event-name-registry.test.ts
 *      for faster CI feedback.
 *
 * Modes:
 *   - default (advisory): exit 0 with WARN if drift found
 *   - --strict:            exit 1 on drift
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const STRICT = process.argv.includes('--strict');

const warnings = [];
const errors = [];

// 1) regeneration determinism — rerun codegen into a buffer, compare to committed files.
function checkCodegenDeterminism() {
  const events = join(__dirname, 'events.generated.ts');
  const enums = join(__dirname, 'enums.generated.ts');
  const beforeEvents = readFileSync(events, 'utf8');
  const beforeEnums = readFileSync(enums, 'utf8');

  execSync(`node ${join(__dirname, 'codegen.mjs')}`, { stdio: 'pipe' });

  const afterEvents = readFileSync(events, 'utf8');
  const afterEnums = readFileSync(enums, 'utf8');

  if (beforeEvents !== afterEvents) {
    errors.push('packages/contracts/events.generated.ts is out of date — run `node packages/contracts/codegen.mjs` and commit.');
    // Restore the committed version so --strict=false doesn't rewrite.
    writeFileSync(events, beforeEvents, 'utf8');
  }
  if (beforeEnums !== afterEnums) {
    errors.push('packages/contracts/enums.generated.ts is out of date — run `node packages/contracts/codegen.mjs` and commit.');
    writeFileSync(enums, beforeEnums, 'utf8');
  }
}

// 2) hand-rolled registry detection (mirrors the jest gate)
function walk(dir, acc = []) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) acc.push(full);
    }
  } catch {}
  return acc;
}

function checkNoHandRolledRegistries() {
  const RE = /export\s+const\s+SocketEvent\s*=\s*\{/;
  const STALE_DUP = /\s[0-9]+\.ts$/;
  const files = walk(join(ROOT, 'src'));
  const offenders = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (rel.includes('__tests__')) continue;
    if (STALE_DUP.test(rel)) continue;
    const c = readFileSync(f, 'utf8');
    if (RE.test(c)) offenders.push(rel);
  }
  // socket.service.ts is allowed IFF it re-exports from the generated module.
  const sock = offenders.find((p) => p.endsWith('src/shared/services/socket.service.ts'));
  if (sock) {
    const c = readFileSync(join(ROOT, sock), 'utf8');
    const reExports = /from\s+['"][^'"]*packages\/contracts\/events\.generated['"]/.test(c);
    if (!reExports) {
      errors.push(`${sock}: declares SocketEvent locally without re-exporting from packages/contracts/events.generated.`);
    }
  }
  const bad = offenders.filter((p) => !p.endsWith('src/shared/services/socket.service.ts'));
  for (const f of bad) {
    warnings.push(`${f}: hand-rolls \`export const SocketEvent = { ... }\` — migrate to \`import { SocketEvent } from '<path>/packages/contracts/events.generated'\`.`);
  }
}

try {
  checkCodegenDeterminism();
} catch (e) {
  errors.push(`codegen failed: ${e.message}`);
}
checkNoHandRolledRegistries();

if (errors.length === 0 && warnings.length === 0) {
  process.stdout.write('[contracts/verify] OK — contracts in sync, no hand-rolled registries found.\n');
  process.exit(0);
}

for (const w of warnings) process.stdout.write(`[contracts/verify] WARN ${w}\n`);
for (const e of errors) process.stdout.write(`[contracts/verify] ERROR ${e}\n`);

if (STRICT && (errors.length || warnings.length)) {
  process.exit(1);
}
// Advisory default: exit 0 so today's CI stays green; flip to --strict in follow-up PRs.
process.exit(errors.length ? 1 : 0);
