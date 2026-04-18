/**
 * =============================================================================
 * CANONICAL HASH UTILITY (F-A-39)
 * =============================================================================
 *
 * Deterministic serialization + short hash for cache keys.
 *
 * Motivation:
 *   The original cache-key builder (`google-maps.service.ts::buildCacheKey`)
 *   relied on `JSON.stringify()` which does NOT guarantee key order, and then
 *   base64-encoded the entire payload. That produced two problems:
 *
 *     1. Same route requested with keys in different order → cache miss.
 *     2. Keys were uncapped in length — for a 25-waypoint call, the base64
 *        blob would blow past Redis key-length recommendations (< 512 bytes)
 *        and bloat memory.
 *
 *   `canonicalize` deeply sorts keys and rounds numeric values to 5 decimal
 *   places (~1.1m precision at the equator — tighter than Google snaps to).
 *   `shortHash` returns the first 16 hex chars of a sha256 digest — 64 bits
 *   of entropy (1 in 18 quintillion collision chance per bucket).
 * =============================================================================
 */

import crypto from 'crypto';

const COORD_PRECISION = 5;

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    Object.getPrototypeOf(val) === Object.prototype
  );
}

/**
 * Recursively produce a deterministic JSON serialization:
 *   - Object keys sorted alphabetically.
 *   - Arrays preserved in order (order is meaningful for waypoints).
 *   - Numbers rounded to 5 decimal places to stabilize float drift.
 *   - null / undefined passed through unchanged.
 *
 * Exported string is stable for the same logical input, independent of how
 * the caller constructed the object.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    // Round to fixed decimals and reparse to eliminate trailing-zero drift.
    return Number(value.toFixed(COORD_PRECISION));
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      out[k] = normalize(value[k]);
    }
    return out;
  }

  return value;
}

/**
 * Short deterministic hash (16 hex chars = 64 bits).
 *
 * Safe for cache keys — collision probability per bucket is ~1/1.8e19.
 * Not cryptographically binding, but adequate for dedupe and cache sharding.
 */
export function shortHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(canonicalize(value))
    .digest('hex')
    .slice(0, 16);
}
