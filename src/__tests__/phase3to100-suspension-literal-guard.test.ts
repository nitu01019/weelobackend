/**
 * =============================================================================
 * W1-5 — F-A-10 Suspension Literal Regression Guard (Preventative)
 * =============================================================================
 *
 * BACKGROUND
 *   Commit 770880f + earlier F-A-10 fixes centralized the Redis suspension
 *   prefix `suspension:` behind a single owner — `adminSuspensionService`
 *   (file: `src/modules/admin/admin-suspension.service.ts`). That service
 *   exposes:
 *     - const SUSPENSION_KEY_PREFIX = 'suspension:'
 *     - const HISTORY_KEY_PREFIX   = 'suspension:history:'
 *     - export const suspensionKey = (userId) => `${SUSPENSION_KEY_PREFIX}${userId}`
 *
 *   Any other module that hard-codes the literal `'suspension:'` (string, or
 *   template-literal starting with `suspension:`) risks re-introducing the
 *   exact drift that F-A-10 fixed: inline prefix that diverges from the
 *   service's source of truth, silently allowing suspended users through.
 *
 * PER evidence pack (Section 5)
 *   - NO current production violations exist. The real-source scan here
 *     passes today. This test is PURELY PREVENTATIVE — it armors against
 *     future regressions.
 *   - Allowlist (the ONLY file where the literal may appear as real code):
 *       src/modules/admin/admin-suspension.service.ts
 *   - Test files are excluded (`__tests__/**`, `*.test.ts`, `*.spec.ts`).
 *
 * WHY NOT ESLint?
 *   ESLint `no-restricted-syntax` was the first-choice approach, but the
 *   Phase-3 plan notes that `.eslintrc.json` edits may be blocked by the
 *   repo protection hook. A source-scan Jest test is:
 *     (a) hook-agnostic,
 *     (b) runs in the existing CI pipeline (`npm test`) with zero config,
 *     (c) gives strictly-scoped file matching via jest allowlist.
 *
 * COMMENTS VS LITERALS
 *   The scanner strips `// line` and `/* block *\/` comments before
 *   matching. This prevents false positives on files like
 *   `src/shared/middleware/auth.middleware.ts` (lines 127, 301), which
 *   legitimately mention `suspension:` in F-A-10 historical commentary.
 *   Only actual single-quote, double-quote, or template-literal uses
 *   starting with `suspension:` are flagged.
 *
 * RED / GREEN LIFECYCLE
 *   Commit 1 (RED): this file + stub `scanForSuspensionLiteral` that always
 *     returns [] — the synthetic "scanner detects bad fixture" test fails.
 *   Commit 2 (GREEN): real scanner implementation — both the synthetic
 *     self-test and the real-source scan pass.
 *
 * @fixes W1-5 / F-A-10
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// Paths
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * The canonical and ONLY allowed holder of the `suspension:` literal in
 * production source code. Any other file containing the literal at code
 * level (not in comments) is a F-A-10 regression.
 */
const ALLOWED_OWNER_REL = 'modules/admin/admin-suspension.service.ts';

// =============================================================================
// Scanner
// =============================================================================

interface LiteralMatch {
  /** 1-based line number where the literal begins in the original source. */
  line: number;
  /** Single-line excerpt starting at the opening quote (for error reports). */
  snippet: string;
  /** Literal kind: single-quote, double-quote, or template-literal. */
  kind: 'single' | 'double' | 'template';
}

/**
 * The needle we are guarding against. Any string/template literal whose
 * opening content begins with this prefix is a F-A-10 regression.
 * Case-sensitive; the F-A-10 Redis key is lowercase by contract.
 */
const SUSPENSION_LITERAL_PREFIX = 'suspension:';

/**
 * Scan a TypeScript source string for any string or template literal whose
 * value begins with `suspension:`. Returns all matches.
 *
 * The scanner walks the source character-by-character with a small state
 * machine that tracks:
 *   - plain code                (default)
 *   - `//` line comments        (skipped)
 *   - `/* *\/` block comments   (skipped)
 *   - single-quote strings      (opening checked for `suspension:`)
 *   - double-quote strings      (opening checked for `suspension:`)
 *   - template literals         (opening checked for `suspension:`)
 *
 * Only the OPENING of each literal is inspected — i.e. the substring
 * immediately following the opening quote. This keeps the scanner linear
 * and precise: `'suspension:foo'` is flagged, but `'foo-suspension:bar'`
 * is NOT (the prefix must be the first thing in the literal).
 *
 * Escape handling: backslash-escaped quotes inside string literals are
 * respected so `'a\'b'` is a single literal. Template interpolation
 * `${...}` is handled by re-entering code-state while inside.
 */
function scanForSuspensionLiteral(source: string): LiteralMatch[] {
  type State =
    | 'code'
    | 'lineComment'
    | 'blockComment'
    | 'singleString'
    | 'doubleString'
    | 'templateString'
    | 'templateExpr';

  const matches: LiteralMatch[] = [];
  let state: State = 'code';
  let line = 1;
  // Depth of nested `${ ... }` inside template literals. When we exit the
  // outermost `${`, we return to templateString state.
  let exprBraceDepth = 0;

  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    // Track line numbers uniformly, regardless of state.
    if (ch === '\n') line++;

    switch (state) {
      case 'code': {
        if (ch === '/' && next === '/') {
          state = 'lineComment';
          i += 2;
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'blockComment';
          i += 2;
          continue;
        }
        if (ch === "'") {
          if (source.startsWith(SUSPENSION_LITERAL_PREFIX, i + 1)) {
            matches.push({ line, snippet: extractOneLine(source, i), kind: 'single' });
          }
          state = 'singleString';
          i += 1;
          continue;
        }
        if (ch === '"') {
          if (source.startsWith(SUSPENSION_LITERAL_PREFIX, i + 1)) {
            matches.push({ line, snippet: extractOneLine(source, i), kind: 'double' });
          }
          state = 'doubleString';
          i += 1;
          continue;
        }
        if (ch === '`') {
          if (source.startsWith(SUSPENSION_LITERAL_PREFIX, i + 1)) {
            matches.push({ line, snippet: extractOneLine(source, i), kind: 'template' });
          }
          state = 'templateString';
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      case 'lineComment': {
        if (ch === '\n') state = 'code';
        i += 1;
        continue;
      }
      case 'blockComment': {
        if (ch === '*' && next === '/') {
          state = 'code';
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      case 'singleString': {
        if (ch === '\\') {
          i += 2; // skip escape + next char
          continue;
        }
        if (ch === "'") {
          state = 'code';
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      case 'doubleString': {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '"') {
          state = 'code';
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      case 'templateString': {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '`') {
          state = 'code';
          i += 1;
          continue;
        }
        if (ch === '$' && next === '{') {
          state = 'templateExpr';
          exprBraceDepth = 1;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      case 'templateExpr': {
        // Inside `${ ... }` — treat sub-strings as independent literals so
        // any nested `'suspension:xxx'` still gets flagged.
        if (ch === '{') {
          exprBraceDepth++;
          i += 1;
          continue;
        }
        if (ch === '}') {
          exprBraceDepth--;
          if (exprBraceDepth === 0) {
            state = 'templateString';
          }
          i += 1;
          continue;
        }
        // Nested strings inside the expression — delegate to a tiny
        // sub-walk that only flags matches and returns the next index
        // after the closing quote.
        if (ch === "'" || ch === '"' || ch === '`') {
          const quote = ch;
          if (source.startsWith(SUSPENSION_LITERAL_PREFIX, i + 1)) {
            matches.push({
              line,
              snippet: extractOneLine(source, i),
              kind: quote === "'" ? 'single' : quote === '"' ? 'double' : 'template',
            });
          }
          i = skipNestedString(source, i, quote as "'" | '"' | '`');
          continue;
        }
        if (ch === '/' && next === '/') {
          state = 'lineComment';
          i += 2;
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'blockComment';
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
    }
  }

  return matches;
}

/**
 * Walk a string literal starting at its opening quote (inclusive) and
 * return the index AFTER the closing quote. Respects `\` escapes.
 */
function skipNestedString(source: string, startIdx: number, quote: "'" | '"' | '`'): number {
  let i = startIdx + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * Return up to `maxLen` characters starting at `startIdx`, trimmed at the
 * first newline. Used for error-report snippets.
 */
function extractOneLine(source: string, startIdx: number, maxLen = 120): string {
  let end = startIdx;
  while (end < source.length && source[end] !== '\n' && end - startIdx < maxLen) {
    end++;
  }
  return source.slice(startIdx, end);
}

// =============================================================================
// File walker
// =============================================================================

/**
 * Recursively collect every `.ts` file under `root`, EXCLUDING test files
 * (anything under `__tests__/`, or ending in `.test.ts` / `.spec.ts`) and
 * EXCLUDING any file in the explicit allowlist.
 */
function collectProductionTsFiles(root: string, allowlistRelPaths: ReadonlyArray<string>): string[] {
  const absAllowlist = new Set(allowlistRelPaths.map((p) => path.join(root, p)));
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip test directories entirely.
        if (ent.name === '__tests__') continue;
        if (ent.name === 'node_modules') continue;
        if (ent.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.ts')) continue;
      if (ent.name.endsWith('.d.ts')) continue;
      if (ent.name.endsWith('.test.ts')) continue;
      if (ent.name.endsWith('.spec.ts')) continue;
      if (absAllowlist.has(full)) continue;
      out.push(full);
    }
  }
  return out;
}

// =============================================================================
// (1) Synthetic self-test — the scanner MUST detect a BAD literal in a
//     fixture string. This is the RED gate in Commit 1 (stub returns []).
// =============================================================================

describe('W1-5 — scanForSuspensionLiteral self-test (synthetic fixture)', () => {
  it('detects a raw single-quote `suspension:` literal', () => {
    const bad = `const k = 'suspension:user-42'; // illegal`;
    const matches = scanForSuspensionLiteral(bad);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].kind).toBe('single');
  });

  it('detects a raw double-quote `suspension:` literal', () => {
    const bad = `const k = "suspension:user-42";`;
    const matches = scanForSuspensionLiteral(bad);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].kind).toBe('double');
  });

  it('detects a template-literal starting with `suspension:`', () => {
    const bad = 'const k = `suspension:${userId}`;';
    const matches = scanForSuspensionLiteral(bad);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].kind).toBe('template');
  });

  it('does NOT flag `//` line comments mentioning `suspension:`', () => {
    const ok = `// the canonical prefix is suspension:\nconst x = 1;`;
    const matches = scanForSuspensionLiteral(ok);
    expect(matches).toHaveLength(0);
  });

  it('does NOT flag `/* */` block comments mentioning `suspension:`', () => {
    const ok = `/* key: suspension:{id} is canonical */\nconst x = 1;`;
    const matches = scanForSuspensionLiteral(ok);
    expect(matches).toHaveLength(0);
  });

  it('does NOT flag unrelated strings', () => {
    const ok = `const a = 'other:prefix'; const b = "suspendedUser";`;
    const matches = scanForSuspensionLiteral(ok);
    expect(matches).toHaveLength(0);
  });
});

// =============================================================================
// (2) Real-source scan — every production `.ts` file under `src/` MUST be
//     free of the `suspension:` literal, EXCEPT the canonical owner.
// =============================================================================

describe('W1-5 — F-A-10 literal guard across production src/', () => {
  const files = collectProductionTsFiles(SRC_ROOT, [ALLOWED_OWNER_REL]);

  it('finds a non-empty list of production TS files to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('produces zero `suspension:` literal violations across all non-allowlisted files', () => {
    const violations: Array<{ file: string; matches: LiteralMatch[] }> = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const matches = scanForSuspensionLiteral(source);
      if (matches.length > 0) {
        violations.push({ file: path.relative(REPO_ROOT, file), matches });
      }
    }
    if (violations.length > 0) {
      const report = violations
        .map(
          (v) =>
            `  ${v.file}:\n` +
            v.matches
              .map((m) => `    line ${m.line} (${m.kind}): ${m.snippet}`)
              .join('\n'),
        )
        .join('\n');
      throw new Error(
        `F-A-10 regression detected. The following file(s) contain the literal ` +
          `'suspension:' outside the canonical owner ` +
          `(src/${ALLOWED_OWNER_REL}). ` +
          `Replace with the exported helper suspensionKey(userId) from ` +
          `'@/modules/admin/admin-suspension.service'.\n\nViolations:\n${report}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('the canonical owner file still exists and still holds the literal (regression guard on the allowlist itself)', () => {
    const ownerFull = path.join(SRC_ROOT, ALLOWED_OWNER_REL);
    expect(fs.existsSync(ownerFull)).toBe(true);
    const ownerSrc = fs.readFileSync(ownerFull, 'utf-8');
    // If someone renames/moves the helper, this assertion flips red so the
    // allowlist is forced to stay in sync with reality.
    expect(ownerSrc).toMatch(/SUSPENSION_KEY_PREFIX\s*=\s*['"]suspension:['"]/);
    expect(ownerSrc).toMatch(/export\s+const\s+suspensionKey\s*=/);
  });
});
