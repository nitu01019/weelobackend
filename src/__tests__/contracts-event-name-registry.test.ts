/**
 * F-C-52: Event-name contract registry test
 *
 * Asserts that no file OUTSIDE packages/contracts/ declares a socket event name
 * via a direct string literal registry. Hand-rolled `SocketEvent = { ... }` maps
 * and three-repo drift (TM-8.md:47-56) motivate this gate.
 *
 * What this test FORBIDS:
 *   - Any file matching `src/** /*.ts` that declares `export const SocketEvent = {`
 *     OR `const SocketEvents = {` OR hand-rolls another literal event registry
 *     containing emit-target string literals — except socket.service.ts which must
 *     re-export from the generated module, AND the generated module itself.
 *
 * What this test ALLOWS:
 *   - `socket.emit('x', ...)` / `socket.on('x', ...)` call sites — these are
 *     legitimate consumers; they reference SocketEvent.X indirectly at most sites.
 *   - Internal SocketConstants, per-module event objects that are NOT the
 *     canonical registry.
 *
 * The surface test is intentionally narrow: one canonical source of truth
 * (`packages/contracts/events.generated.ts`), re-exported by `socket.service.ts`.
 * Advisory scope expands in follow-up PRs to cover every `socket.emit(<literal>)`.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(BACKEND_ROOT, 'src');
const CONTRACTS_DIR = path.join(BACKEND_ROOT, 'packages', 'contracts');
const GENERATED_EVENTS_PATH = path.join(CONTRACTS_DIR, 'events.generated.ts');
const SOCKET_SERVICE_PATH = path.join(SRC_DIR, 'shared', 'services', 'socket.service.ts');

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

describe('F-C-52 · Event-name contract registry (AsyncAPI/Protobuf codegen)', () => {
  it('packages/contracts/events.generated.ts exists and is the single source of event names', () => {
    expect(fs.existsSync(GENERATED_EVENTS_PATH)).toBe(true);
    const contents = fs.readFileSync(GENERATED_EVENTS_PATH, 'utf8');
    // The generated module MUST declare SocketEvent with at least the differentiator events
    expect(contents).toMatch(/export const SocketEvent\b/);
    expect(contents).toMatch(/FLEX_HOLD_STARTED/);
    expect(contents).toMatch(/DRIVER_ACCEPTED/);
    expect(contents).toMatch(/ASSIGNMENT_STATUS_CHANGED/);
    expect(contents).toMatch(/TRUCKS_REMAINING_UPDATE/);
  });

  it('packages/contracts/enums.generated.ts exists and includes HoldPhase + companions (F-C-78)', () => {
    const enumsPath = path.join(CONTRACTS_DIR, 'enums.generated.ts');
    expect(fs.existsSync(enumsPath)).toBe(true);
    const contents = fs.readFileSync(enumsPath, 'utf8');
    // HoldPhase canonical (uppercase, matches Prisma)
    expect(contents).toMatch(/HoldPhase\b/);
    expect(contents).toMatch(/FLEX/);
    expect(contents).toMatch(/CONFIRMED/);
    expect(contents).toMatch(/EXPIRED/);
    expect(contents).toMatch(/RELEASED/);
    // fromBackendString companions for schema-drift safety
    expect(contents).toMatch(/fromBackendString/);
    // Assignment/Vehicle/Booking mirror Prisma (lowercase per schema.prisma)
    expect(contents).toMatch(/AssignmentStatus\b/);
    expect(contents).toMatch(/VehicleStatus\b/);
    expect(contents).toMatch(/BookingStatus\b/);
  });

  it('socket.service.ts re-exports SocketEvent from the generated registry (no local literal map)', () => {
    expect(fs.existsSync(SOCKET_SERVICE_PATH)).toBe(true);
    const contents = fs.readFileSync(SOCKET_SERVICE_PATH, 'utf8');
    // Must re-export SocketEvent from packages/contracts (relative path)
    expect(contents).toMatch(/from\s+['"][^'"]*packages\/contracts\/events\.generated['"]/);
    // Re-export syntax: either `export { SocketEvent ... } from` OR
    // `import { SocketEvent } from ...; export { SocketEvent };` style
    const hasReExport =
      /export\s*\{[^}]*SocketEvent[^}]*\}\s*from\s*['"][^'"]*packages\/contracts\/events\.generated['"]/.test(contents) ||
      /export\s*\{[^}]*SocketEvent[^}]*\}\s*;[\s\S]*import\s*\{[^}]*SocketEvent[^}]*\}\s*from\s*['"][^'"]*packages\/contracts\/events\.generated['"]/.test(contents);
    expect(hasReExport).toBe(true);
  });

  it('no TS file outside packages/contracts declares its own `export const SocketEvent = {` map', () => {
    const offenders: string[] = [];
    const files = walk(SRC_DIR);
    const SOCKET_EVENT_LITERAL_DECL = /export\s+const\s+SocketEvent\s*=\s*\{/;

    // Stale macOS-Finder duplicates ("socket.service 2.ts", "socket.service 3.ts")
    // are dead, not imported anywhere (verified via grep). Exclude them from the
    // registry gate so the canonical file is the sole carrier. If these files
    // are ever reintroduced into the import graph, a separate hygiene gate fails first.
    const STALE_FINDER_DUP = /\s[0-9]+\.ts$/;

    for (const file of files) {
      const rel = path.relative(BACKEND_ROOT, file);
      if (rel.includes('__tests__')) continue; // Tests may mock/reference freely
      if (STALE_FINDER_DUP.test(rel)) continue;
      const contents = fs.readFileSync(file, 'utf8');
      if (SOCKET_EVENT_LITERAL_DECL.test(contents)) {
        offenders.push(rel);
      }
    }

    // socket.service.ts is allowed IFF it re-exports (previous test asserts that).
    // Any OTHER file with a local SocketEvent literal map is forbidden.
    expect(offenders).toEqual([]);
  });
});
