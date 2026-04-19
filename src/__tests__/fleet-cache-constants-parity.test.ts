/**
 * =============================================================================
 * F-B-02 Phase A — fleet-cache constants parity
 * =============================================================================
 *
 * Before this change, `fleet-cache.service.ts` re-declared FLEET_CACHE_PREFIX,
 * CACHE_KEYS, and CACHE_TTL inline with copy-pasted values that matched
 * `fleet-cache-types.ts` by coincidence. Any future edit to the types module
 * silently drifted.
 *
 * This test pins the invariant: the class and the free-function module must
 * use the EXACT same constants, because a divergence between the two paths
 * (one key shape in writes, another in reads) would produce cache entries
 * that are invisible to readers.
 *
 * Phase A simply de-duplicates the constants (import from types). Phase C
 * (follow-up PR) removes the class entirely.
 * =============================================================================
 */

import {
  FLEET_CACHE_PREFIX as TYPES_PREFIX,
  CACHE_KEYS as TYPES_KEYS,
  CACHE_TTL as TYPES_TTL,
} from '../shared/services/fleet-cache-types';

// Force-import the class module to make sure it loads without throwing after
// the deduplication. We don't introspect its private constants — instead we
// rely on the import-statement-level check: if fleet-cache.service.ts still
// had its own `const FLEET_CACHE_PREFIX = ...` it would shadow the imported
// name, and we detect that by scanning the source text below.
import '../shared/services/fleet-cache.service';
import * as fs from 'fs';
import * as path from 'path';

const CLASS_PATH = path.resolve(__dirname, '../shared/services/fleet-cache.service.ts');
const TYPES_PATH = path.resolve(__dirname, '../shared/services/fleet-cache-types.ts');

describe('F-B-02 fleet-cache constants parity', () => {
  it('fleet-cache.service.ts does NOT re-declare FLEET_CACHE_PREFIX locally', () => {
    const src = fs.readFileSync(CLASS_PATH, 'utf8');
    // The only `const FLEET_CACHE_PREFIX` anywhere in the file should be GONE
    // (the canonical one lives in fleet-cache-types.ts). Import references are
    // allowed ( `FLEET_CACHE_PREFIX` inside `import { ... }` ).
    const declarationRegex = /\bconst\s+FLEET_CACHE_PREFIX\s*=/;
    expect(declarationRegex.test(src)).toBe(false);
  });

  it('fleet-cache.service.ts does NOT re-declare CACHE_KEYS locally', () => {
    const src = fs.readFileSync(CLASS_PATH, 'utf8');
    const declarationRegex = /\bconst\s+CACHE_KEYS\s*=\s*\{/;
    expect(declarationRegex.test(src)).toBe(false);
  });

  it('fleet-cache.service.ts does NOT re-declare CACHE_TTL locally', () => {
    const src = fs.readFileSync(CLASS_PATH, 'utf8');
    const declarationRegex = /\bconst\s+CACHE_TTL\s*=\s*\{/;
    expect(declarationRegex.test(src)).toBe(false);
  });

  it('fleet-cache.service.ts imports constants from fleet-cache-types', () => {
    const src = fs.readFileSync(CLASS_PATH, 'utf8');
    // Accept either a multi-line or single-line import form.
    expect(src).toMatch(/from\s+['"]\.\/fleet-cache-types['"]/);
    expect(src).toMatch(/FLEET_CACHE_PREFIX/);
    expect(src).toMatch(/CACHE_KEYS/);
    expect(src).toMatch(/CACHE_TTL/);
  });

  it('types module exposes the canonical prefix (fleetcache: — F-B-03 contract)', () => {
    expect(TYPES_PREFIX).toBe('fleetcache:');
  });

  it('types module exposes the canonical key-builder shape (F-B-03 contract)', () => {
    const txid = '11111111-2222-3333-4444-555555555555';
    expect(TYPES_KEYS.VEHICLES(txid)).toBe(`fleetcache:vehicles:${txid}`);
    expect(TYPES_KEYS.VEHICLE('v1')).toBe('fleetcache:vehicle:v1');
    expect(TYPES_KEYS.DRIVERS(txid)).toBe(`fleetcache:drivers:${txid}`);
    expect(TYPES_KEYS.DRIVER('d1')).toBe('fleetcache:driver:d1');
    expect(TYPES_KEYS.VEHICLES_AVAILABLE(txid)).toBe(`fleetcache:vehicles:available:${txid}`);
    expect(TYPES_KEYS.DRIVERS_AVAILABLE(txid)).toBe(`fleetcache:drivers:available:${txid}`);
    expect(TYPES_KEYS.AVAILABILITY_SNAPSHOT(txid, 'OPEN')).toBe(`fleetcache:snapshot:${txid}:open`);
    expect(TYPES_KEYS.VEHICLES_BY_TYPE(txid, 'Open', '17ft')).toBe(
      `fleetcache:vehicles:${txid}:type:open:17ft`
    );
  });

  it('types module exposes canonical TTLs used by broadcasts and cache-aside', () => {
    expect(TYPES_TTL.VEHICLE_LIST).toBe(300);
    expect(TYPES_TTL.DRIVER_LIST).toBe(300);
    expect(TYPES_TTL.INDIVIDUAL).toBe(600);
    expect(TYPES_TTL.SNAPSHOT).toBe(60);
  });

  it('types module file compiles and exports interfaces (CachedVehicle / CachedDriver / AvailabilitySnapshot)', () => {
    const src = fs.readFileSync(TYPES_PATH, 'utf8');
    expect(src).toMatch(/export\s+interface\s+CachedVehicle/);
    expect(src).toMatch(/export\s+interface\s+CachedDriver/);
    expect(src).toMatch(/export\s+interface\s+AvailabilitySnapshot/);
  });
});
