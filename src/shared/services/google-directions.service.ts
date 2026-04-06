/**
 * =============================================================================
 * GOOGLE DIRECTIONS SERVICE — ETA-Based Transporter Ranking
 * =============================================================================
 *
 * Provides real road-distance ETA for ranking transporter candidates
 * during broadcast dispatch. Uses Google Directions API Distance Matrix.
 *
 * FALLBACK CHAIN:
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Directions API → Haversine (automatic via directionsCircuit)
 *
 * COST CONTROL:
 * - Max 25 origins per Distance Matrix request (Google limit)
 * - Candidates >25 are chunked into multiple requests
 * - 3-second timeout per request (trucks are not time-critical like cabs)
 * - Circuit breaker opens after 5 failures → all ranking falls back to haversine
 *
 * ENV VARS:
 * - GOOGLE_MAPS_API_KEY (required)
 *
 * @author Weelo Engineering
 * =============================================================================
 */

import { logger } from './logger.service';
import { directionsCircuit } from './circuit-breaker.service';
// Fix F2: Import shared haversine instead of local duplicate
import { haversineDistanceKm } from '../utils/geospatial.utils';

// =============================================================================
// CONFIGURATION
// =============================================================================

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

/** Maximum origins per Distance Matrix request (Google limit) */
const MAX_ORIGINS_PER_REQUEST = 25;

/** Timeout for each Google API call */
const API_TIMEOUT_MS = 3_000;

// =============================================================================
// TYPES
// =============================================================================

export interface ETARankedCandidate {
    transporterId: string;
    latitude: number;
    longitude: number;
    etaSeconds: number;
    distanceMeters: number;
    source: 'google' | 'haversine';
}

interface DistanceMatrixElement {
    status: string;
    duration?: { value: number; text: string };
    distance?: { value: number; text: string };
}

interface DistanceMatrixResponse {
    status: string;
    rows: Array<{
        elements: DistanceMatrixElement[];
    }>;
}

// =============================================================================
// HAVERSINE (ALWAYS-AVAILABLE FALLBACK)
// =============================================================================

// Fix F2: Local haversineDistanceKm removed -- now imported from geospatial.utils

/**
 * Estimate ETA from haversine distance.
 * Assumes average truck speed of 30 km/h in city + 10% buffer for turns.
 */
function haversineETASeconds(distanceKm: number): number {
    const avgSpeedKmh = 30;
    const bufferMultiplier = 1.1;
    return Math.ceil((distanceKm / avgSpeedKmh) * 3600 * bufferMultiplier);
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

class GoogleDirectionsService {

    /**
     * Rank transporter candidates by real-world ETA using Google Distance Matrix.
     * Automatically falls back to haversine if Google API fails.
     *
     * @param pickupLat   Pickup latitude
     * @param pickupLng   Pickup longitude
     * @param candidates  Array of transporter candidates with lat/lng
     * @returns           Sorted by ETA ascending (nearest arrives first)
     */
    async rankByETA(
        pickupLat: number,
        pickupLng: number,
        candidates: Array<{ transporterId: string; latitude: number; longitude: number }>
    ): Promise<ETARankedCandidate[]> {
        if (candidates.length === 0) return [];

        // If no API key configured, use haversine directly (no error, just fallback)
        if (!GOOGLE_MAPS_API_KEY) {
            logger.debug('[GoogleDirections] No API key configured — using haversine fallback');
            return this.rankByHaversine(pickupLat, pickupLng, candidates);
        }

        // Use circuit breaker: Google API primary → haversine fallback
        return directionsCircuit.tryWithFallback(
            () => this.rankByGoogleAPI(pickupLat, pickupLng, candidates),
            () => Promise.resolve(this.rankByHaversine(pickupLat, pickupLng, candidates))
        );
    }

    /**
     * Google Distance Matrix API call.
     * Chunks candidates into batches of 25 (Google limit).
     */
    private async rankByGoogleAPI(
        pickupLat: number,
        pickupLng: number,
        candidates: Array<{ transporterId: string; latitude: number; longitude: number }>
    ): Promise<ETARankedCandidate[]> {
        const destination = `${pickupLat},${pickupLng}`;
        const results: ETARankedCandidate[] = [];

        // Chunk into batches of MAX_ORIGINS_PER_REQUEST
        for (let i = 0; i < candidates.length; i += MAX_ORIGINS_PER_REQUEST) {
            const chunk = candidates.slice(i, i + MAX_ORIGINS_PER_REQUEST);
            const origins = chunk.map(c => `${c.latitude},${c.longitude}`).join('|');

            const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
                `?origins=${encodeURIComponent(origins)}` +
                `&destinations=${encodeURIComponent(destination)}` +
                `&mode=driving` +
                `&key=${GOOGLE_MAPS_API_KEY}`;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

            try {
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeout);

                if (!response.ok) {
                    throw new Error(`Google API HTTP ${response.status}`);
                }

                const data = (await response.json()) as DistanceMatrixResponse;

                if (data.status !== 'OK') {
                    throw new Error(`Google API status: ${data.status}`);
                }

                // Map each row to its candidate
                for (let j = 0; j < chunk.length; j++) {
                    const element = data.rows?.[j]?.elements?.[0];
                    const candidate = chunk[j];

                    if (element?.status === 'OK' && element.duration && element.distance) {
                        results.push({
                            transporterId: candidate.transporterId,
                            latitude: candidate.latitude,
                            longitude: candidate.longitude,
                            etaSeconds: element.duration.value,
                            distanceMeters: element.distance.value,
                            source: 'google'
                        });
                    } else {
                        // Google couldn't route this origin — haversine fallback for this one
                        const distKm = haversineDistanceKm(
                            candidate.latitude, candidate.longitude, pickupLat, pickupLng
                        );
                        results.push({
                            transporterId: candidate.transporterId,
                            latitude: candidate.latitude,
                            longitude: candidate.longitude,
                            etaSeconds: haversineETASeconds(distKm),
                            distanceMeters: distKm * 1000,
                            source: 'haversine'
                        });
                    }
                }
            } catch (error: any) {
                clearTimeout(timeout);
                // If this chunk fails, fall back to haversine for the entire chunk
                logger.warn(`[GoogleDirections] Chunk ${Math.floor(i / MAX_ORIGINS_PER_REQUEST) + 1} failed: ${error.message}`);
                for (const candidate of chunk) {
                    const distKm = haversineDistanceKm(
                        candidate.latitude, candidate.longitude, pickupLat, pickupLng
                    );
                    results.push({
                        transporterId: candidate.transporterId,
                        latitude: candidate.latitude,
                        longitude: candidate.longitude,
                        etaSeconds: haversineETASeconds(distKm),
                        distanceMeters: distKm * 1000,
                        source: 'haversine'
                    });
                }

                // Re-throw to let circuit breaker count the failure
                // (only if ALL candidates used haversine = full API failure)
                if (i === 0 && chunk.length === candidates.length) {
                    throw error;
                }
            }
        }

        // Sort by ETA ascending — nearest transporter first
        results.sort((a, b) => a.etaSeconds - b.etaSeconds);

        const googleCount = results.filter(r => r.source === 'google').length;
        logger.info(`[GoogleDirections] Ranked ${results.length} candidates: ${googleCount} via Google, ${results.length - googleCount} via haversine`, {
            matchingSource: googleCount > 0 ? 'google_directions' : 'haversine',
            totalCandidates: results.length,
            googleRanked: googleCount
        });

        return results;
    }

    /**
     * Pure haversine fallback — always available, zero external calls.
     */
    rankByHaversine(
        pickupLat: number,
        pickupLng: number,
        candidates: Array<{ transporterId: string; latitude: number; longitude: number }>
    ): ETARankedCandidate[] {
        return candidates
            .map(c => {
                const distKm = haversineDistanceKm(c.latitude, c.longitude, pickupLat, pickupLng);
                return {
                    transporterId: c.transporterId,
                    latitude: c.latitude,
                    longitude: c.longitude,
                    etaSeconds: haversineETASeconds(distKm),
                    distanceMeters: distKm * 1000,
                    source: 'haversine' as const
                };
            })
            .sort((a, b) => a.etaSeconds - b.etaSeconds);
    }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const googleDirectionsService = new GoogleDirectionsService();
