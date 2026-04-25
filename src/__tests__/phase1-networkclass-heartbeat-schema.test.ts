/**
 * =============================================================================
 * W-(-1) T-9 — RED gate: HeartbeatRequest Zod schema + POST heartbeat route
 *               wiring for optional `networkClass` field (E4 pilot).
 *
 * This test MUST fail RED until W-5 / E4.4 lands. Pairings:
 *   - E4-1b backend route destructure at
 *     src/modules/transporter/transporter.routes.ts:523
 *   - Backend Zod `heartbeatRequestSchema` in
 *     src/modules/driver/driver.schema.ts
 *   - Service signature `handleHeartbeat(driverId, data)` already accepts the
 *     optional field (verified); the gap is schema + route wiring.
 *
 * Flag (authoritative per hardening_master.md §4 W-5): FF_NETWORK_CLASS_HEARTBEAT
 * (task description loosely referenced FF_PRESENCE_NETWORK_CLASS — the real
 * env-var name in the code is FF_NETWORK_CLASS_HEARTBEAT; this test asserts
 * against the real name).
 *
 * Scope: source-grep only (matches master plan §6 row 9 acceptance criterion).
 * =============================================================================
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const DRIVER_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  'modules',
  'driver',
  'driver.schema.ts',
);

const TRANSPORTER_ROUTES_PATH = path.join(
  __dirname,
  '..',
  'modules',
  'transporter',
  'transporter.routes.ts',
);

const DRIVER_PRESENCE_SERVICE_PATH = path.join(
  __dirname,
  '..',
  'modules',
  'driver',
  'driver-presence.service.ts',
);

const DRIVER_SERVICE_PATH = path.join(
  __dirname,
  '..',
  'modules',
  'driver',
  'driver.service.ts',
);

function readIfExists(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf-8');
}

describe('W-(-1) T-9: phase1-networkclass-heartbeat-schema (RED until W-5 E4.4)', () => {
  describe('Assertion 1 — Backend Zod `heartbeatRequestSchema` declares `networkClass`', () => {
    const schemaSrc = readIfExists(DRIVER_SCHEMA_PATH);

    it('exports a heartbeat Zod schema (heartbeatRequestSchema or similar)', () => {
      const hasSchema =
        /export\s+const\s+heartbeatRequestSchema\s*=\s*z\.object/.test(schemaSrc) ||
        /export\s+const\s+heartbeatSchema\s*=\s*z\.object/.test(schemaSrc) ||
        /export\s+const\s+HeartbeatRequestSchema\s*=\s*z\.object/.test(schemaSrc);
      expect(
        hasSchema,
      ).toBe(
        // Citing missing target per RED-gate convention:
        // "networkClass field absent from HeartbeatRequest schema — add in W-5 E4.4"
        // (schema block itself does not yet exist in driver.schema.ts).
        true,
      );
    });

    it('heartbeat schema declares `networkClass: z.enum([...]).nullable().optional()` (canonical + telephony aliases)', () => {
      // Expected literal per B2 fix (verify_B2_networkclass_drift.md §4.2):
      //   networkClass: z.enum([
      //     'WIFI', '4G', '5G', '3G', '2G', 'UNKNOWN',
      //     'NR', 'LTE', 'HSPA', 'EDGE', 'CELL', 'NONE',
      //   ]).nullable().optional()
      // The Captain Android app emits telephony names; Zod accepts BOTH the
      // canonical (iOS/future) and the alias forms; server-side
      // normalizeNetworkClass collapses both to the canonical bucket.
      const declaresEnum =
        /networkClass\s*:\s*z\.enum\(\s*\[[^\]]*['"]WIFI['"][^\]]*['"]UNKNOWN['"][^\]]*\]\s*\)/m.test(
          schemaSrc,
        ) ||
        /networkClass\s*:\s*z\.enum\(\s*\[[\s\S]*?['"]WIFI['"][\s\S]*?['"]UNKNOWN['"][\s\S]*?\]\s*\)/m.test(
          schemaSrc,
        );
      const declaresModifiers =
        /networkClass\s*:\s*z\.enum\([\s\S]*?\)\s*\.nullable\(\)\s*\.optional\(\)/m.test(
          schemaSrc,
        ) ||
        /networkClass\s*:\s*z\.enum\([\s\S]*?\)\s*\.optional\(\)\s*\.nullable\(\)/m.test(
          schemaSrc,
        );
      // B2: assert all 6 Captain Android telephony aliases are accepted by the
      // wire-form Zod enum (NR/LTE/HSPA/EDGE/CELL/NONE). These are the values
      // NetworkClassifier.kt actually emits today — server normalises them
      // post-parse via TELEPHONY_ALIASES in presence.config.ts.
      const acceptsTelephonyAliases =
        /['"]NR['"]/.test(schemaSrc) &&
        /['"]LTE['"]/.test(schemaSrc) &&
        /['"]HSPA['"]/.test(schemaSrc) &&
        /['"]EDGE['"]/.test(schemaSrc) &&
        /['"]CELL['"]/.test(schemaSrc) &&
        /['"]NONE['"]/.test(schemaSrc);
      expect(declaresEnum && declaresModifiers && acceptsTelephonyAliases).toBe(
        // Citing target (B2 fix — verify_B2_networkclass_drift.md): driver.schema.ts
        // must declare `networkClass: z.enum([...canonical, ...telephony]).nullable().optional()`
        // so the cellular cohort no longer 400s on /heartbeat.
        true,
      );
    });
  });

  describe('Assertion 2 — POST heartbeat route destructures `networkClass` and forwards it', () => {
    const routeSrc = readIfExists(TRANSPORTER_ROUTES_PATH);

    it('router.post(`/heartbeat`, ...) destructures networkClass from req.body or parseResult.data', () => {
      // Expected shape (E4-1b, master plan §4 W-5):
      //   const { latitude, longitude, vehicleId, isOnTrip, networkClass } = req.body;
      // OR (W-5 g11 S3 fix):
      //   const { ... networkClass } = parseResult.data;
      const destructuresNetworkClass =
        /const\s*\{[^}]*\bnetworkClass\b[^}]*\}\s*=\s*(req\.body|parseResult\.data)/.test(routeSrc);
      expect(destructuresNetworkClass).toBe(true);
    });

    it('the heartbeat route forwards networkClass into the presence update call', () => {
      // Expected: route passes networkClass through to handleHeartbeat / presence update.
      // Accept either direct call with networkClass in the data object, or a
      // labelled networkClass argument to a presence service method.
      const forwardsToPresence =
        /handleHeartbeat\s*\(\s*[^)]*networkClass[^)]*\)/.test(routeSrc) ||
        /updatePresence\s*\(\s*[^)]*networkClass[^)]*\)/.test(routeSrc) ||
        /onHeartbeat\s*\(\s*[^)]*networkClass[^)]*\)/.test(routeSrc);
      expect(forwardsToPresence).toBe(
        // Citing missing target: the `/heartbeat` route does not pass networkClass
        // to any presence service call yet — add forwarding in W-5 E4.1b.
        true,
      );
    });
  });

  describe('Assertion 3 — Presence service signature accepts optional `networkClass`', () => {
    const presenceServiceSrc = readIfExists(DRIVER_PRESENCE_SERVICE_PATH);
    const driverServiceSrc = readIfExists(DRIVER_SERVICE_PATH);

    it('driverPresenceService.handleHeartbeat(data) accepts `networkClass?: string`', () => {
      // Already partially true in driver-presence.service.ts — but assertion
      // also requires parity in driver.service.ts handleHeartbeat signature.
      const presenceAccepts =
        /handleHeartbeat\s*\([^)]*\bnetworkClass\?\s*:\s*string\b/.test(
          presenceServiceSrc,
        );
      const driverServiceAccepts =
        /handleHeartbeat\s*\([^)]*\bnetworkClass\?\s*:\s*string\b/.test(
          driverServiceSrc,
        );
      // Require BOTH call sites to have consistent signature for W-5 wiring to
      // be safe. If one is missing, declare RED and cite which.
      expect(presenceAccepts && driverServiceAccepts).toBe(
        // Citing target: both driver-presence.service.ts and driver.service.ts
        // must expose `networkClass?: string` on handleHeartbeat so the route
        // forwarding lands without type errors (W-5 E4.4 companion to E4.1b).
        true,
      );
    });
  });

  describe('Assertion 4 — Flag OFF: networkClass is ignored / not persisted', () => {
    const presenceServiceSrc = readIfExists(DRIVER_PRESENCE_SERVICE_PATH);

    it('handleHeartbeat gates networkClass persistence behind FF_NETWORK_CLASS_HEARTBEAT', () => {
      // Flag-gated assignment already present in driver-presence.service.ts:295-296.
      // Verify it is still source-grep present (so W-5 edits do not regress it).
      const gated =
        /isEnabled\s*\(\s*FLAGS\.NETWORK_CLASS_HEARTBEAT\s*\)/.test(
          presenceServiceSrc,
        );
      const conditionalPersist =
        /includeNetworkClass\s*&&\s*networkClass\s*!==\s*undefined/.test(
          presenceServiceSrc,
        );
      expect(gated && conditionalPersist).toBe(
        // Citing target: FF_NETWORK_CLASS_HEARTBEAT gate and conditional Redis
        // payload assignment must be present in handleHeartbeat. Asserted here
        // as a companion RED to guarantee W-5 does not regress flag-OFF parity.
        true,
      );
    });
  });

  describe('Assertion 5 — Flag ON: networkClass is persisted to Redis presence payload', () => {
    const presenceServiceSrc = readIfExists(DRIVER_PRESENCE_SERVICE_PATH);

    it('handleHeartbeat writes networkClass into the Redis presence JSON when flag ON', () => {
      // Expected literal shape in driver-presence.service.ts:307-309:
      //   if (includeNetworkClass && networkClass !== undefined) {
      //     presencePayload.networkClass = networkClass;
      //   }
      const writesNetworkClass =
        /presencePayload\.networkClass\s*=\s*networkClass/.test(
          presenceServiceSrc,
        );
      expect(writesNetworkClass).toBe(
        // Citing target: Redis presence payload must assign `networkClass` field
        // when flag ON. Present in driver-presence.service.ts — RED companion
        // ensures W-5 E4.4 does not regress the persistence path.
        true,
      );
    });

    it('the Redis write call is preceded by normalizeNetworkClass(data.networkClass)', () => {
      // Normalization shields the persistence path from garbage input.
      const normalized =
        /normalizeNetworkClass\s*\(\s*data\.networkClass\s*\)/.test(
          presenceServiceSrc,
        );
      expect(normalized).toBe(
        // Citing target: normalizeNetworkClass(data.networkClass) must be applied
        // before writing to Redis. Current presence-service has this; RED gate
        // locks the behavior so W-5 route forwarding inherits a normalized value.
        true,
      );
    });
  });
});
