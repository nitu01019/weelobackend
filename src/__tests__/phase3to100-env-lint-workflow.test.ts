/**
 * =============================================================================
 * PHASE 3 -> 100% — W1-4: CI Env-Lint Workflow Shape Guard (F-C-75)
 * =============================================================================
 *
 * BACKGROUND
 *   The script `npm run lint:env` (scripts/verify-env-example.ts) catches
 *   drift between `src/shared/config/env.config.ts` (runtime truth) and
 *   `.env.example` (developer onboarding truth). Per Wave 1 evidence pack
 *   (Section 4), the script works locally (exit 0) but NO CI workflow
 *   invokes it — so a PR that removes a key from `.env.example` while
 *   leaving it declared in `env.config.ts` would merge silently, breaking
 *   new-developer onboarding and deployment config parity.
 *
 * THIS TEST ASSERTS THAT:
 *   (1) `.github/workflows/env-lint.yml` exists.
 *   (2) It contains the exact step `run: npm run lint:env`.
 *   (3) It triggers on both `pull_request` and `push` to `main`.
 *   (4) It pins `node-version` compatible with the `engines.node`
 *       declaration in `package.json`.
 *   (5) It runs on `ubuntu-latest`.
 *   (6) It contains no tab characters (YAML indentation correctness).
 *
 * Per task spec W1-4: a GitHub Actions workflow cannot be directly
 * unit-tested — this shape test is the closest proxy that catches
 * accidental deletion or corruption of the workflow file (regression
 * armor for F-C-75 CI wiring).
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants anchored to the repo root so tests run deterministically from any
// cwd Jest is launched under.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'env-lint.yml',
);
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

// ---------------------------------------------------------------------------
// Load helpers — kept tiny; a full YAML parser is NOT a project dependency,
// and the assertions we need are all string-level (regex) matches.
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  engines?: {
    node?: string;
  };
}

function readWorkflow(): string {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

function readPackageJson(): PackageJsonShape {
  return JSON.parse(
    fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'),
  ) as PackageJsonShape;
}

/**
 * Parse a semver-like lower bound (`>=18.0.0`, `18`, `20.x`) into the major
 * version integer. Returns NaN if parsing fails; callers assert on the
 * resulting number explicitly.
 */
function parseEnginesNodeMajor(enginesNode: string): number {
  const match = enginesNode.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : NaN;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('W1-4 env-lint.yml workflow shape (F-C-75)', () => {
  it('workflow file exists at .github/workflows/env-lint.yml', () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it('workflow invokes `npm run lint:env` as a step', () => {
    const yml = readWorkflow();
    // Exact step line — matches `- run: npm run lint:env` with optional
    // surrounding whitespace. YAML allows both `run: npm run lint:env`
    // and `run: "npm run lint:env"`; we accept either.
    expect(yml).toMatch(/run:\s*["']?npm run lint:env["']?/);
  });

  it('workflow triggers on pull_request', () => {
    const yml = readWorkflow();
    // Either `on: [pull_request, ...]` or YAML block form `on:\n  pull_request:`
    expect(yml).toMatch(/pull_request/);
  });

  it('workflow triggers on push to main', () => {
    const yml = readWorkflow();
    // Must contain a `push:` trigger AND reference `main` branch.
    expect(yml).toMatch(/push:/);
    expect(yml).toMatch(/branches:\s*\[\s*main\s*\]|-\s*main/);
  });

  it('workflow runs on ubuntu-latest', () => {
    const yml = readWorkflow();
    expect(yml).toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it('workflow pins a node-version compatible with package.json engines.node', () => {
    const yml = readWorkflow();
    const pkg = readPackageJson();

    const enginesNode = pkg.engines?.node;
    expect(enginesNode).toBeDefined();

    const minMajor = parseEnginesNodeMajor(enginesNode as string);
    expect(Number.isNaN(minMajor)).toBe(false);

    // Extract the `node-version: '20'` style declaration.
    const nodeVersionMatch = yml.match(
      /node-version:\s*["']?(\d+)(?:\.[\dx]+)?(?:\.[\dx]+)?["']?/,
    );
    expect(nodeVersionMatch).not.toBeNull();

    const workflowMajor = parseInt(
      (nodeVersionMatch as RegExpMatchArray)[1],
      10,
    );
    // Workflow Node major must be >= engines.node major (forward compat OK,
    // never run CI on an older runtime than the codebase declares support for).
    expect(workflowMajor).toBeGreaterThanOrEqual(minMajor);
  });

  it('workflow uses npm ci before lint:env to install deps', () => {
    const yml = readWorkflow();
    // Both steps must appear, and `npm ci` must come BEFORE `npm run lint:env`
    // (otherwise ts-node isn't installed when the script runs).
    const ciIdx = yml.indexOf('npm ci');
    const lintIdx = yml.search(/npm run lint:env/);
    expect(ciIdx).toBeGreaterThanOrEqual(0);
    expect(lintIdx).toBeGreaterThanOrEqual(0);
    expect(ciIdx).toBeLessThan(lintIdx);
  });

  it('workflow uses actions/checkout and actions/setup-node', () => {
    const yml = readWorkflow();
    expect(yml).toMatch(/uses:\s*actions\/checkout@/);
    expect(yml).toMatch(/uses:\s*actions\/setup-node@/);
  });

  it('workflow uses npm cache in setup-node to keep CI under 5 min', () => {
    const yml = readWorkflow();
    // `cache: npm` or `cache: 'npm'` — either is valid YAML.
    expect(yml).toMatch(/cache:\s*["']?npm["']?/);
  });

  it('workflow file contains no tab characters (YAML indentation rule)', () => {
    const yml = readWorkflow();
    // YAML forbids tabs for indentation; mixing tabs with spaces is the #1
    // cause of silent workflow parse failures in GitHub Actions.
    expect(yml.includes('\t')).toBe(false);
  });
});
