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

/** Redis key prefix for H3 cell sets (includes resolution for safety) */
const H3_CELL_KEY_PREFIX = `h3:${H3_RESOLUTION}`;

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

// =============================================================================
// KEY GENERATORS
// =============================================================================

function cellKey(cellId: string, vehicleKey: string): string {
    // Fix D6/F-3-7: Dev-mode guard — colons in components would corrupt the key structure
    if (process.env.NODE_ENV !== 'production') {
        if (cellId.includes(':') || vehicleKey.includes(':')) {
            logger.warn(`[H3Index] cellKey components must not contain colons`, { cellId, vehicleKey });
        }
    }
    return `${H3_CELL_KEY_PREFIX}:${cellId}:${vehicleKey}`;
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
            const key = cellKey(cell, vehicleKey);

            // H-P3 FIX: Atomic SADD+EXPIRE via Lua script to prevent orphaned sets without TTL
            await Promise.all([
                redisService.sAddWithExpire(key, H3_CELL_TTL_SECONDS, transporterId),
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

            // H-P3 FIX: Atomic SADD+EXPIRE via Lua script for each vehicle key
            const ops: Promise<any>[] = [];
            for (const vk of vehicleKeys) {
                const key = cellKey(cell, vk);
                ops.push(redisService.sAddWithExpire(key, H3_CELL_TTL_SECONDS, transporterId));
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

            const ops: Promise<any>[] = [redisService.del(posKey(transporterId))];
            for (const vk of vehicleKeys) {
                if (vk) {
                    ops.push(redisService.sRem(cellKey(cell, vk), transporterId));
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
                    // Same cell — sliding window: refresh BOTH pos AND cell TTLs
                    const refreshOps: Promise<any>[] = [
                        redisService.expire(posKey(transporterId), H3_POS_TTL_SECONDS).catch(() => { })
                    ];
                    for (const vk of vehicleKeys) {
                        refreshOps.push(
                            redisService.expire(cellKey(newCell, vk), H3_CELL_TTL_SECONDS).catch(() => { })
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
     */
    async getCandidatesNewRing(
        pickupLat: number,
        pickupLng: number,
        vehicleKey: string,
        ringK: number,
        alreadyNotified: Set<string>
    ): Promise<string[]> {
        try {
            if (ringK === 0) {
                return this.getCandidates(pickupLat, pickupLng, vehicleKey, 0, alreadyNotified);
            }

            const originCell = this.latLngToCell(pickupLat, pickupLng);
            const newRingCells = this.gridRingUnsafe(originCell, ringK);

            const keys = newRingCells.map(cell => cellKey(cell, vehicleKey));
            if (keys.length === 0) return [];

            let members: string[];
            if (keys.length === 1) {
                members = await redisService.sMembers(keys[0]).catch(() => []);
            } else {
                members = await redisService.sUnion(...keys).catch(() => []);
            }

            return members.filter(id => !alreadyNotified.has(id));
        } catch (error: any) {
            logger.error(`[H3Index] getCandidatesNewRing failed: ${error.message}`, {
                vehicleKey, ringK
            });
            return [];
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
