/**
 * =============================================================================
 * PRESENCE CONFIG — SSOT (F-B-05)
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
 * DRIVER_PRESENCE_TTL_SECONDS = 3 * heartbeat (36s)
 *   → survives 3 missed heartbeats before auto-offline. Matches the previous
 *     35s value within 1s (the old literal was one-window shy of a clean 3x).
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

export const HEARTBEAT_INTERVAL_SECONDS = parseInt(
  process.env.PRESENCE_HEARTBEAT_INTERVAL_SECONDS ?? '12',
  10,
);

export const DRIVER_PRESENCE_TTL_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 3;

export const TRANSPORTER_PRESENCE_TTL_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 5;

// Invariant guard — surface a misconfigured heartbeat at startup, not at 4am.
if (DRIVER_PRESENCE_TTL_SECONDS <= 2 * HEARTBEAT_INTERVAL_SECONDS) {
  throw new Error(
    `[presence.config] invariant violated: DRIVER_PRESENCE_TTL_SECONDS ` +
      `(${DRIVER_PRESENCE_TTL_SECONDS}) must be > 2 * HEARTBEAT_INTERVAL_SECONDS ` +
      `(${HEARTBEAT_INTERVAL_SECONDS}). Check PRESENCE_HEARTBEAT_INTERVAL_SECONDS.`,
  );
}
