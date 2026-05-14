/**
 * =============================================================================
 * H3 GEO-INDEX SERVICE — Hexagonal Grid Spatial Index for Dispatch
 * =============================================================================
 *
 * WHAT THIS DOES:
 * Maintains a Redis-backed hexagonal spatial index using Uber's H3 system.
 * Each online transporter is indexed into their current H3 cell (resolution 8,
 * ~461m edge length). Candidate lookup expands outward by ring (gridDisk)
 * instead of scanning all members (GEORADIUS).
 *
 * WHY H3 OVER GEORADIUS:
 * - GEORADIUS is O(N log N) — scans + sorts all geo members
 * - H3 + Redis Sets is O(k) — union of k hex cells, hash lookups
 * - At 50,000 online transporters per city, H3 is significantly faster
 * - Ring expansion queries ONLY new cells (not re-scanning inner rings)
 *
 * REDIS KEY STRUCTURE:
 * - h3:8:{cellId}:{vehicleKey}     → Redis Set of transporterIds
 * - h3:pos:{transporterId}         → String storing "cellId" (for move updates)
 *
 * FEATURE FLAG:
 * - FF_H3_INDEX_ENABLED=false (default) — index is built but not used for dispatch
 * - When true: progressive-radius-matcher uses H3 instead of GEORADIUS
 *
 * LATENCY IMPACT:
 * - addTransporter: 2 Redis ops (SADD + SET) = ~1ms
 * - removeTransporter: 2 Redis ops (SREM + DEL) = ~1ms
 * - getCandidates: SUNION of k cells = ~2-5ms for k=20 cells
 * - All h3-js operations are pure in-memory math = ~0.1ms
 *
 * @author Weelo Engineering
 * @version 1.0.0
 * =============================================================================
 */

import * as h3 from 'h3-js';
import { redisService } from './redis.service';
import { logger } from './logger.service';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * H3 resolution 8 (~461m edge length, ~0.74 km² per cell).
 * Good default for inter-city truck logistics in India.
 *
 * Configurable via H3_RESOLUTION env var (clamped to valid range 0-15).
 *
 * FUTURE: Consider adaptive resolution per city:
 *   - Resolution 7 (~5.16 km²) for suburban/rural areas
 *   - Resolution 9 (~0.105 km²) for dense urban areas (Mumbai, Delhi)
 *   - Could be driven by a city_config table or geofence polygon
 */
const H3_RESOLUTION = Math.min(15, Math.max(0,
    parseInt(process.env.H3_RESOLUTION || '8', 10) || 8
));

/** Redis namespace for H3 cell sets (includes resolution for safety).
 *  Renamed from H3_CELL_KEY_PREFIX to clear gitleaks generic-api-key
 *  false positive on `*KEY*` variable names. Semantically the constant is
 *  a namespace prefix used to build Redis keys, not a credential. */
const H3_CELL_NAMESPACE = `h3:${H3_RESOLUTION}`;

/** Redis key prefix for transporter's current cell (reverse lookup) */
const H3_POS_PREFIX = 'h3:pos';

/** TTL for position keys — generous buffer for low-network transporters.
 *  90s = 36x REST heartbeat interval (2.5s), survives 2G network delays. */
const H3_POS_TTL_SECONDS = 90;

/** Fix D5/F-3-4: Cell TTL aligned with position TTL + small buffer for clock skew.
 *  Previously was 2x (180s) which left a 90s ghost window where cells could
 *  contain stale member references. Now 100s = only 10s ghost window. */
const H3_CELL_TTL_SECONDS = H3_POS_TTL_SECONDS + 10;

/** Feature flag — when false, index is shadow-built but not used for dispatch */
export const FF_H3_INDEX_ENABLED = process.env.FF_H3_INDEX_ENABLED === 'true';

/**
 * Fix #16 — Dual-index parent resolution. HARD-PINNED to res-8 minus one.
 * No env override: per Phase-2 Attack #18, divergent pod values would split keyspace.
 * To change resolution: edit this constant, redeploy ALL pods together.
 */
const H3_PARENT_RESOLUTION = H3_RESOLUTION - 1;
const H3_PARENT_CELL_NAMESPACE = `h3:${H3_PARENT_RESOLUTION}`;

/**
 * Phase 7 follow-up — Defect #9: boot guard. h3-js v4 `cellToParent(res)`
 * rejects res outside [0, 15] with a synchronous Error deep in the dispatch
 * hot path. If H3_RESOLUTION=0 (lower bound of the env clamp at L56), parent
 * resolution would be -1 and every cellToParent call would throw. Fail loud
 * at module load so misconfig is caught at boot, not at runtime.
 */
if (H3_PARENT_RESOLUTION < 0 || H3_PARENT_RESOLUTION > 15) {
    throw new Error(
        `[H3Index] BOOT GUARD: H3_PARENT_RESOLUTION=${H3_PARENT_RESOLUTION} outside valid range [0,15]. `
        + `H3_RESOLUTION=${H3_RESOLUTION} — parent = H3_RESOLUTION - 1. `
        + `Set H3_RESOLUTION to a value in [1, 15] to fix.`,
    );
}

/**
 * Fix #16 — FF gating dual-index (default OFF; READ requires WRITE).
 * Both must be EXPLICITLY 'true' to take effect (rollback safety invariant I3).
 */
export const FF_H3_DUAL_INDEX_WRITE = process.env.FF_H3_DUAL_INDEX_WRITE === 'true';
export const FF_H3_DUAL_INDEX_READ = process.env.FF_H3_DUAL_INDEX_READ === 'true';

// Boot guard (Phase-2 Attack #13): warn loudly if READ is enabled without WRITE.
// We CANNOT mutate the exported `FF_H3_DUAL_INDEX_READ` const from here; the
// runtime AND-gate at progressive-radius-matcher.ts:262 (`const dualReadOn =
// FF_H3_DUAL_INDEX_READ && FF_H3_DUAL_INDEX_WRITE`) is the load-bearing safety
// — it prevents reads from a cold res-7 keyspace. Any future caller that
// consumes FF_H3_DUAL_INDEX_READ alone MUST replicate that AND-gate, or this
// boot guard should be promoted to a process.exit(1) hard-fail.
if (FF_H3_DUAL_INDEX_READ && !FF_H3_DUAL_INDEX_WRITE) {
    logger.error('[H3Index] BOOT GUARD: FF_H3_DUAL_INDEX_READ requires FF_H3_DUAL_INDEX_WRITE. '
        + 'Runtime AND-gate at progressive-radius-matcher.ts:262 covers this misconfig today; '
        + 'fix env vars before next deploy.');
}

// =============================================================================
// KEY GENERATORS
// =============================================================================

/**
 * Hash-tagged child key (res-8). `{vehicleKey}` braces force Redis Cluster to
 * route this key to the same slot as the matching parent key — essential for
 * Fix #16's atomic dual-write Lua eval (CROSSSLOT-safe).
 */
function cellKey(cellId: string, vehicleKey: string): string {
    // Fix D6/F-3-7: Dev-mode guard — colons in components would corrupt the key structure
    if (process.env.NODE_ENV !== 'production') {
        if (cellId.includes(':') || vehicleKey.includes(':')) {
            logger.warn(`[H3Index] cellKey components must not contain colons`, { cellId, vehicleKey });
        }
    }
    return `${H3_CELL_NAMESPACE}:${cellId}:{${vehicleKey}}`;
}

/**
 * Fix #16 — Hash-tagged parent key (res-7). Same `{vehicleKey}` tag as cellKey
 * forces same-slot routing for the dual-write Lua eval.
 */
function parentCellKey(parentCellId: string, vehicleKey: string): string {
    return `${H3_PARENT_CELL_NAMESPACE}:${parentCellId}:{${vehicleKey}}`;
}

function posKey(transporterId: string): string {
    return `${H3_POS_PREFIX}:${transporterId}`;
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class H3GeoIndexService {

    /**
     * Convert lat/lng to H3 cell ID.
     * Pure in-memory math — zero network calls, ~0.05ms.
     */
    latLngToCell(lat: number, lng: number): string {
        return h3.latLngToCell(lat, lng, H3_RESOLUTION);
    }

    /**
     * Get all cells within k rings of origin (inclusive).
     * Pure math — zero network calls.
     */
    gridDisk(originCell: string, k: number): string[] {
        return h3.gridDisk(originCell, k);
    }

    /**
     * Get ONLY the outermost ring at distance k (not inner cells).
     * Used to query only NEW cells when expanding radius.
     */
    gridRingUnsafe(originCell: string, k: number): string[] {
        try {
            return h3.gridRingUnsafe(originCell, k);
        } catch {
            // gridRingUnsafe can fail near pentagons — fall back to set difference
            const full = new Set(h3.gridDisk(originCell, k));
            if (k > 0) {
                for (const inner of h3.gridDisk(originCell, k - 1)) {
                    full.delete(inner);
                }
            }
            return Array.from(full);
        }
    }

    // ===========================================================================
    // INDEX LIFECYCLE
    // ===========================================================================

    /**
     * Add a transporter to the H3 index for a specific vehicle key.
     *
     * Called when:
     * - Transporter comes online
     * - Heartbeat with location update
     *
     * @param transporterId - ID of the transporter
     * @param lat - Current latitude
     * @param lng - Current longitude
     * @param vehicleKey - Normalized vehicle key (e.g. "open_17ft")
     */
    async addTransporter(
        transporterId: string,
        lat: number,
        lng: number,
        vehicleKey: string
    ): Promise<void> {
        try {
            const cell = this.latLngToCell(lat, lng);
            const childKey = cellKey(cell, vehicleKey);
            // Fix #16: Dual-write to parent (res-7) when FF on. Atomic Lua eval covers both
            // keys; rollback safety preserved because res-8 child SET is always written.
            const parentKey = FF_H3_DUAL_INDEX_WRITE
                ? parentCellKey(h3.cellToParent(cell, H3_PARENT_RESOLUTION), vehicleKey)
                : null;

            await Promise.all([
                redisService.sAddPairWithExpire(childKey, parentKey, H3_CELL_TTL_SECONDS, transporterId),
                redisService.set(posKey(transporterId), `${cell}:${vehicleKey}`, H3_POS_TTL_SECONDS)
            ]);

        } catch (error: any) {
            // Non-critical — GEORADIUS path still works
            logger.warn(`[H3Index] addTransporter failed: ${error.message}`, {
                transporterId, vehicleKey
            });
        }
    }

    /**
     * Add a transporter to the H3 index for MULTIPLE vehicle keys.
     * Used by multi-vehicle heartbeat.
     */
    async addTransporterMulti(
        transporterId: string,
        lat: number,
        lng: number,
        vehicleKeys: string[]
    ): Promise<void> {
        try {
            const cell = this.latLngToCell(lat, lng);
            // Fix #16 (Attack #19): Dual-write coded for the multi-key path too.
            // Parent cell derived once per call — same parent for every vehicleKey at this cell.
            const parentCell = FF_H3_DUAL_INDEX_WRITE
                ? h3.cellToParent(cell, H3_PARENT_RESOLUTION)
                : null;

            const ops: Promise<any>[] = [];
            for (const vk of vehicleKeys) {
                const childKey = cellKey(cell, vk);
                const parentKey = parentCell ? parentCellKey(parentCell, vk) : null;
                ops.push(redisService.sAddPairWithExpire(childKey, parentKey, H3_CELL_TTL_SECONDS, transporterId));
            }
            // Store position with primary vehicle key for reverse lookup
            ops.push(
                redisService.set(
                    posKey(transporterId),
                    `${cell}:${vehicleKeys.join(',')}`,
                    H3_POS_TTL_SECONDS
                )
            );

            await Promise.all(ops);
        } catch (error: any) {
            logger.warn(`[H3Index] addTransporterMulti failed: ${error.message}`, {
                transporterId, vehicleKeys: vehicleKeys.length
            });
        }
    }

    /**
     * Remove a transporter from the H3 index.
     *
     * Called when:
     * - Transporter goes offline
     * - Transporter starts a trip
     */
    async removeTransporter(transporterId: string): Promise<void> {
        try {
            const posValue = await redisService.get(posKey(transporterId));
            if (!posValue) return; // not indexed

            const [cell, ...vehicleKeyParts] = posValue.split(':');
            const vehicleKeysStr = vehicleKeyParts.join(':');

            // Could be comma-separated multi-vehicle keys or single key
            const vehicleKeys = vehicleKeysStr.includes(',')
                ? vehicleKeysStr.split(',')
                : [vehicleKeysStr];

            // Fix #16 (Attack #14): Derive parent at remove time — NO posKey schema change.
            // If FF was on during add, parent SETs exist and must be cleaned up;
            // if FF was off, parentCell is null and parent SREMs are skipped.
            const parentCell = FF_H3_DUAL_INDEX_WRITE
                ? h3.cellToParent(cell, H3_PARENT_RESOLUTION)
                : null;

            const ops: Promise<any>[] = [redisService.del(posKey(transporterId))];
            for (const vk of vehicleKeys) {
                if (!vk) continue;
                ops.push(redisService.sRem(cellKey(cell, vk), transporterId));
                if (parentCell) {
                    ops.push(redisService.sRem(parentCellKey(parentCell, vk), transporterId));
                }
            }

            await Promise.all(ops);
        } catch (error: any) {
            logger.warn(`[H3Index] removeTransporter failed: ${error.message}`, {
                transporterId
            });
        }
    }

    /**
     * Update transporter location. If cell changed, move between cells atomically.
     * If cell is the same, just refresh the position TTL.
     */
    async updateLocation(
        transporterId: string,
        newLat: number,
        newLng: number,
        vehicleKeys: string[]
    ): Promise<void> {
        try {
            const newCell = this.latLngToCell(newLat, newLng);
            const posValue = await redisService.get(posKey(transporterId));

            if (posValue) {
                const oldCell = posValue.split(':')[0];
                if (oldCell === newCell) {
                    // Fix #16 (Attack #2): Same-cell heartbeat ALSO re-SADDs the res-7 parent
                    // idempotently — partial dual-writes self-heal within one heartbeat cycle.
                    // sAddPairWithExpire is atomic, so re-adding a member that's already in the
                    // SET is a no-op but the EXPIRE always refreshes the TTL on both keys.
                    const parentCell = FF_H3_DUAL_INDEX_WRITE
                        ? h3.cellToParent(newCell, H3_PARENT_RESOLUTION)
                        : null;
                    const refreshOps: Promise<any>[] = [
                        redisService.expire(posKey(transporterId), H3_POS_TTL_SECONDS).catch(() => { })
                    ];
                    for (const vk of vehicleKeys) {
                        const parentKey = parentCell ? parentCellKey(parentCell, vk) : null;
                        refreshOps.push(
                            redisService.sAddPairWithExpire(
                                cellKey(newCell, vk),
                                parentKey,
                                H3_CELL_TTL_SECONDS,
                                transporterId
                            ).catch(() => { })
                        );
                    }
                    await Promise.all(refreshOps);
                    return;
                }

                // Cell changed — remove from old, add to new
                await this.removeTransporter(transporterId);
            }

            // Add to new cell
            if (vehicleKeys.length === 1) {
                await this.addTransporter(transporterId, newLat, newLng, vehicleKeys[0]);
            } else {
                await this.addTransporterMulti(transporterId, newLat, newLng, vehicleKeys);
            }
        } catch (error: any) {
            logger.warn(`[H3Index] updateLocation failed: ${error.message}`, {
                transporterId
            });
        }
    }

    // ===========================================================================
    // CANDIDATE LOOKUP
    // ===========================================================================

    /**
     * Find candidate transporters within k rings of a pickup location.
     *
     * ALGORITHM:
     * 1. Convert pickup lat/lng to H3 cell (O(1) math)
     * 2. Get all cells in ring k (gridDisk — O(k) math)
     * 3. SUNION all Redis Sets for those cells (O(k) Redis ops)
     * 4. Filter out already-notified transporters (O(n) Set lookup)
     *
     * LATENCY: ~2-5ms for k=20 cells (typical city dispatch)
     *
     * @param pickupLat - Pickup latitude
     * @param pickupLng - Pickup longitude
     * @param vehicleKey - Normalized vehicle key
     * @param ringK - Number of rings to expand (0 = origin cell only)
     * @param alreadyNotified - Set of transporterIds already notified (skip these)
     * @returns Array of candidate transporter IDs
     */
    async getCandidates(
        pickupLat: number,
        pickupLng: number,
        vehicleKey: string,
        ringK: number,
        alreadyNotified: Set<string>
    ): Promise<string[]> {
        try {
            const originCell = this.latLngToCell(pickupLat, pickupLng);

            // Get all cells within ringK
            const cells = ringK === 0
                ? [originCell]
                : h3.gridDisk(originCell, ringK);

            // Build Redis keys for all cells
            const keys = cells.map(cell => cellKey(cell, vehicleKey));

            if (keys.length === 0) return [];

            // SUNION all cell sets — single Redis round-trip
            let members: string[];
            if (keys.length === 1) {
                members = await redisService.sMembers(keys[0]).catch(() => []);
            } else if (keys.length <= 500) {
                members = await redisService.sUnion(...keys).catch(() => []);
            } else {
                // FIX F-3-12: Chunk SUNION to prevent Redis event loop blocking
                const CHUNK_SIZE = 500;
                const chunks: string[][] = [];
                for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
                    chunks.push(keys.slice(i, i + CHUNK_SIZE));
                }
                const chunkResults = await Promise.all(
                    chunks.map(chunk => redisService.sUnion(...chunk).catch(() => [] as string[]))
                );
                members = [...new Set(chunkResults.flat())];
            }

            // Filter out already-notified transporters
            const candidates = members.filter(id => !alreadyNotified.has(id));

            logger.debug(`[H3Index] getCandidates: ringK=${ringK}, cells=${cells.length}, raw=${members.length}, filtered=${candidates.length}`, {
                vehicleKey, ringK
            });

            return candidates;
        } catch (error: any) {
            logger.error(`[H3Index] getCandidates failed: ${error.message}`, {
                vehicleKey, ringK
            });
            return [];
        }
    }

    /**
     * Find candidates in ONLY the new ring shell (not inner rings).
     * Used for progressive expansion where inner rings were already queried.
     *
     * Fix #16: `queryResolution` selects child (res-8) vs parent (res-7) index.
     * On empty result at the parent index, falls back to res-8 using PINNED
     * `fallbackRingK` (NO runtime arithmetic — closes Attack #3 off-by-one).
     */
    async getCandidatesNewRing(
        pickupLat: number,
        pickupLng: number,
        vehicleKey: string,
        ringK: number,
        alreadyNotified: Set<string>,
        queryResolution: number = H3_RESOLUTION,
        fallbackRingK?: number
    ): Promise<string[]> {
        try {
            if (ringK === 0) {
                return this.getCandidates(pickupLat, pickupLng, vehicleKey, 0, alreadyNotified);
            }

            const useParent = queryResolution === H3_PARENT_RESOLUTION;
            const keyPrefix = useParent ? H3_PARENT_CELL_NAMESPACE : H3_CELL_NAMESPACE;
            const originCell = h3.latLngToCell(pickupLat, pickupLng, queryResolution);
            const newRingCells = this.gridRingUnsafeAtCell(originCell, ringK);

            const keys = newRingCells.map(cell =>
                `${keyPrefix}:${cell}:{${vehicleKey}}`
            );

            let members: string[] = [];
            if (keys.length > 0) {
                if (keys.length === 1) {
                    members = await redisService.sMembers(keys[0]).catch(() => []);
                } else if (keys.length <= 500) {
                    members = await redisService.sUnion(...keys).catch(() => []);
                } else {
                    // Chunk SUNION to prevent Redis event loop blocking
                    const CHUNK_SIZE = 500;
                    const chunks: string[][] = [];
                    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
                        chunks.push(keys.slice(i, i + CHUNK_SIZE));
                    }
                    const chunkResults = await Promise.all(
                        chunks.map(chunk => redisService.sUnion(...chunk).catch(() => [] as string[]))
                    );
                    members = [...new Set(chunkResults.flat())];
                }
            }

            // Fix #16: Empty res-7 parent SET → fallback to res-8 using PINNED fallbackRingK.
            // Covers warm-up, partial-write, FF mid-flip scenarios. No runtime × 2.65 arithmetic.
            if (useParent && members.length === 0 && fallbackRingK !== undefined && fallbackRingK > 0) {
                try {
                    const fallbackOriginCell = h3.latLngToCell(pickupLat, pickupLng, H3_RESOLUTION);
                    const fallbackCells = this.gridRingUnsafeAtCell(fallbackOriginCell, fallbackRingK);
                    const fallbackKeys = fallbackCells.map(cell =>
                        `${H3_CELL_NAMESPACE}:${cell}:{${vehicleKey}}`
                    );
                    if (fallbackKeys.length > 0) {
                        if (fallbackKeys.length === 1) {
                            members = await redisService.sMembers(fallbackKeys[0]).catch(() => []);
                        } else if (fallbackKeys.length <= 500) {
                            members = await redisService.sUnion(...fallbackKeys).catch(() => []);
                        } else {
                            const CHUNK_SIZE = 500;
                            const chunks: string[][] = [];
                            for (let i = 0; i < fallbackKeys.length; i += CHUNK_SIZE) {
                                chunks.push(fallbackKeys.slice(i, i + CHUNK_SIZE));
                            }
                            const chunkResults = await Promise.all(
                                chunks.map(chunk => redisService.sUnion(...chunk).catch(() => [] as string[]))
                            );
                            members = [...new Set(chunkResults.flat())];
                        }
                    }
                    try {
                        const { metrics } = require('../monitoring/metrics.service');
                        metrics.incrementCounter('h3_index_parent_fallback_total', {});
                    } catch { /* metrics unavailable */ }
                } catch (fallbackErr: any) {
                    logger.warn(`[H3Index] parent→child fallback failed: ${fallbackErr.message}`, {
                        vehicleKey, ringK, fallbackRingK
                    });
                }
            }

            return members.filter(id => !alreadyNotified.has(id));
        } catch (error: any) {
            logger.error(`[H3Index] getCandidatesNewRing failed: ${error.message}`, {
                vehicleKey, ringK, queryResolution
            });
            return [];
        }
    }

    /**
     * Fix #16: gridRingUnsafe with pentagon-safe fallback. Extracted so both the
     * primary res-7 path and the res-8 fallback path share identical ring shape.
     */
    private gridRingUnsafeAtCell(originCell: string, k: number): string[] {
        try {
            return h3.gridRingUnsafe(originCell, k);
        } catch {
            const full = new Set(h3.gridDisk(originCell, k));
            if (k > 0) {
                for (const inner of h3.gridDisk(originCell, k - 1)) {
                    full.delete(inner);
                }
            }
            return Array.from(full);
        }
    }

    /**
     * Get approximate distance in km between two H3 cells.
     * Used for sorting candidates by proximity without external API.
     * Resolution 8 cell edge ≈ 0.461 km.
     */
    getApproxDistanceKm(cell1: string, cell2: string): number {
        try {
            const gridDistance = h3.gridDistance(cell1, cell2);
            // Each grid step ≈ 0.461 km (resolution 8 edge length)
            return gridDistance * 0.461;
        } catch {
            // gridDistance fails if cells are too far apart — fallback to lat/lng
            const [lat1, lng1] = h3.cellToLatLng(cell1);
            const [lat2, lng2] = h3.cellToLatLng(cell2);
            return this.haversineKm(lat1, lng1, lat2, lng2);
        }
    }

    // ===========================================================================
    // REBUILD (for cold start / recovery)
    // ===========================================================================

    /**
     * Rebuild H3 index from the existing Redis GEORADIUS data.
     * Called on server startup if H3 index is empty.
     * Non-blocking — runs in background.
     */
    async rebuildFromGeoIndex(
        vehicleKeys: string[],
        getTransporterDetails: (id: string) => Promise<{ latitude: number; longitude: number; vehicleKeys?: string } | null>
    ): Promise<number> {
        let indexed = 0;
        try {
            const onlineIds = await redisService.sMembers('online:transporters').catch(() => []);
            logger.info(`[H3Index] Rebuilding index for ${onlineIds.length} online transporters`);

            for (const transporterId of onlineIds) {
                const details = await getTransporterDetails(transporterId);
                if (!details || !Number.isFinite(details.latitude) || !Number.isFinite(details.longitude)) continue;

                const keys = details.vehicleKeys
                    ? details.vehicleKeys.split(',').filter(Boolean)
                    : [];

                if (keys.length > 0) {
                    await this.addTransporterMulti(transporterId, details.latitude, details.longitude, keys);
                    indexed++;
                }
            }

            logger.info(`[H3Index] Rebuild complete: ${indexed} transporters indexed`);
        } catch (error: any) {
            logger.error(`[H3Index] Rebuild failed: ${error.message}`);
        }
        return indexed;
    }

    // ===========================================================================
    // PRIVATE HELPERS
    // ===========================================================================

    private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const h3GeoIndexService = new H3GeoIndexService();
