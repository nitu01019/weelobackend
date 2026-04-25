/**
 * =============================================================================
 * PRESENCE CONFIG — SSOT (F-B-05, A11-005 / E4-3)
 * =============================================================================
 *
 * Single source of truth for heartbeat interval and presence-key TTLs.
 *
 * Historically three literal constants diverged across driver/transporter
 * services (driver=35s, transporter=60s) with no shared provenance. This file
 * canonicalises them as derivations of a single heartbeat interval, so the
 * invariant `ttl > N * heartbeat` is provable at module load time.
 *
 * Heartbeat interval: 12s (captain/driver apps; availability.service.ts heartbeats
 * independently at 5s).
 *
 * DRIVER_PRESENCE_TTL_SECONDS = ttlMultiplier * heartbeat
 *   → ttlMultiplier=7 (84s) when FF_NETWORK_CLASS_HEARTBEAT=true: tolerates
 *     2G/handover gaps so flaky drivers are not falsely marked offline. The
 *     network-class signal feeds the adaptive delivery path, so we lean on a
 *     larger TTL to let it converge.
 *   → ttlMultiplier=3 (36s) when the flag is OFF: legacy "3 missed heartbeats"
 *     auto-offline behaviour preserved as a kill-switch.
 *
 * TRANSPORTER_PRESENCE_TTL_SECONDS = 5 * heartbeat (60s) — documented exception.
 *   → Transporter apps spend more time backgrounded on phones; longer cellular
 *     suspension tolerance matches Discord gateway docs (REF-3 F-B-05).
 *     Kept at 60s to preserve existing transporter behaviour.
 *
 * Override via `PRESENCE_HEARTBEAT_INTERVAL_SECONDS` env var if needed.
 * The invariant below throws at import time on pathological configs.
 * =============================================================================
 */

import { FLAGS, isEnabled } from './feature-flags';

export const HEARTBEAT_INTERVAL_SECONDS = parseInt(
  process.env.PRESENCE_HEARTBEAT_INTERVAL_SECONDS ?? '12',
  10,
);

const ttlMultiplier = isEnabled(FLAGS.NETWORK_CLASS_HEARTBEAT) ? 7 : 3;

export const DRIVER_PRESENCE_TTL_SECONDS = HEARTBEAT_INTERVAL_SECONDS * ttlMultiplier;

export const TRANSPORTER_PRESENCE_TTL_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 5;

// Invariant guard — surface a misconfigured heartbeat at startup, not at 4am.
if (DRIVER_PRESENCE_TTL_SECONDS <= 2 * HEARTBEAT_INTERVAL_SECONDS) {
  throw new Error(
    `[presence.config] invariant violated: DRIVER_PRESENCE_TTL_SECONDS ` +
      `(${DRIVER_PRESENCE_TTL_SECONDS}) must be > 2 * HEARTBEAT_INTERVAL_SECONDS ` +
      `(${HEARTBEAT_INTERVAL_SECONDS}). Check PRESENCE_HEARTBEAT_INTERVAL_SECONDS.`,
  );
}

// =============================================================================
// W-5 E4-2 — networkClass normalizer (SSOT for route-facing wire format).
// =============================================================================
// The Captain app (Android) reports network class using telephony-friendly
// labels: WIFI / 4G / 5G / 3G / 2G / UNKNOWN. The SERVICE-LEVEL persistence
// path in driver-presence.service.ts and driver.service.ts uses Android
// API-name labels (WIFI / NR / LTE / HSPA / EDGE / UNKNOWN) for the M1 pilot.
// Both inline definitions are preserved (keep-orphans) so log-only telemetry
// already in flight does not regress.
//
// This route-facing normalizer is the canonical entry point for the new
// transporter `/heartbeat` Zod schema (E4-1b). It:
//   - Accepts string | null | undefined.
//   - Uppercases + matches against the WIRE enum.
//   - Returns null when input is absent or unrecognised, so Zod-level
//     `.nullable().optional()` survives downstream without coercing garbage
//     to 'UNKNOWN' silently at the boundary.
// =============================================================================

export type NetworkClass = 'WIFI' | '4G' | '5G' | '3G' | '2G' | 'UNKNOWN';

export const NETWORK_CLASS_VALUES: ReadonlyArray<NetworkClass> = [
  'WIFI',
  '4G',
  '5G',
  '3G',
  '2G',
  'UNKNOWN',
] as const;

const NETWORK_CLASS_SET: ReadonlySet<NetworkClass> = new Set<NetworkClass>(
  NETWORK_CLASS_VALUES,
);

// W-5 E4-2.1 (B2 fix — verify_B2_networkclass_drift.md) — Captain (Android)
// telephony aliases. NetworkClassifier.kt emits Android-API names
// (NR/LTE/HSPA/EDGE/CELL/NONE) which were 100%-rejected by the route Zod and
// defeated the 84s presence TTL fix for the cellular cohort. Mapping is
// applied server-side at the route normaliser so cellular drivers no longer
// 400 on /heartbeat. iOS / future Captain releases are expected to emit the
// canonical wire form directly.
const TELEPHONY_ALIASES: ReadonlyMap<string, NetworkClass> = new Map<string, NetworkClass>([
  ['NR',   '5G'],
  ['LTE',  '4G'],
  ['HSPA', '3G'],
  ['EDGE', '2G'],
  ['CELL', 'UNKNOWN'],
  ['NONE', 'UNKNOWN'],
]);

export function normalizeNetworkClass(
  raw: string | null | undefined,
): NetworkClass | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase();
  // 1. Already canonical wire form — identity.
  if (NETWORK_CLASS_SET.has(upper as NetworkClass)) {
    return upper as NetworkClass;
  }
  // 2. Captain Android telephony alias — collapse to canonical bucket.
  const aliased = TELEPHONY_ALIASES.get(upper);
  if (aliased) return aliased;
  // 3. Unknown wire form — drop quietly (preserve existing nullable contract).
  return null;
}
