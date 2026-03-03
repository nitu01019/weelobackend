/**
 * =============================================================================
 * CANDIDATE SCORER SERVICE — Unit Tests
 * =============================================================================
 *
 * Tests the two-tier ETA-based scoring used for dispatch candidate ranking.
 * Tier 1 (Haversine) is the fallback. Tier 2 (Google Directions) is default ON.
 *
 * Run: npx jest --testPathPattern="candidate-scorer" --forceExit
 * =============================================================================
 */

import { candidateScorerService, CandidateInput } from '../shared/services/candidate-scorer.service';

// Test candidates — various distances from a pickup point in Delhi
const PICKUP_LAT = 28.6139;
const PICKUP_LNG = 77.2090;

const testCandidates: CandidateInput[] = [
    // 10km away — should be scored lower (worse) than 2km
    { transporterId: 't-far', distanceKm: 10, latitude: 28.70, longitude: 77.30 },
    // 2km away — should be scored highest (best)
    { transporterId: 't-close', distanceKm: 2, latitude: 28.63, longitude: 77.21 },
    // 5km away — middle
    { transporterId: 't-mid', distanceKm: 5, latitude: 28.65, longitude: 77.25 },
    // 0.5km away — closest
    { transporterId: 't-nearest', distanceKm: 0.5, latitude: 28.615, longitude: 77.210 },
];

describe('CandidateScorerService', () => {

    describe('scoreAndRank (ETA-based scoring)', () => {

        it('should return empty array for empty candidates', async () => {
            const result = await candidateScorerService.scoreAndRank([], PICKUP_LAT, PICKUP_LNG);
            expect(result).toHaveLength(0);
        });

        it('should score all candidates with Haversine ETA', async () => {
            const result = await candidateScorerService.scoreAndRank(
                testCandidates, PICKUP_LAT, PICKUP_LNG
            );

            expect(result).toHaveLength(4);
            for (const candidate of result) {
                expect(candidate.etaSeconds).toBeGreaterThan(0);
                expect(candidate.etaSource).toMatch(/^(haversine|haversine_fallback|google_api|cache)$/);
                expect(candidate.transporterId).toBeTruthy();
            }
        });

        it('should sort candidates by ETA (fastest first)', async () => {
            const result = await candidateScorerService.scoreAndRank(
                testCandidates, PICKUP_LAT, PICKUP_LNG
            );

            // ETAs should be in ascending order
            for (let i = 1; i < result.length; i++) {
                expect(result[i].etaSeconds).toBeGreaterThanOrEqual(result[i - 1].etaSeconds);
            }
        });

        it('should rank closest transporter first', async () => {
            const result = await candidateScorerService.scoreAndRank(
                testCandidates, PICKUP_LAT, PICKUP_LNG
            );

            // t-nearest (0.5km) should be first
            expect(result[0].transporterId).toBe('t-nearest');
            // t-far (10km) should be last
            expect(result[result.length - 1].transporterId).toBe('t-far');
        });

        it('should preserve all candidate fields', async () => {
            const result = await candidateScorerService.scoreAndRank(
                testCandidates, PICKUP_LAT, PICKUP_LNG
            );

            for (const candidate of result) {
                expect(candidate.distanceKm).toBeGreaterThan(0);
                expect(candidate.latitude).toBeDefined();
                expect(candidate.longitude).toBeDefined();
            }
        });

        it('should handle single candidate', async () => {
            const result = await candidateScorerService.scoreAndRank(
                [testCandidates[0]], PICKUP_LAT, PICKUP_LNG
            );

            expect(result).toHaveLength(1);
            expect(result[0].transporterId).toBe('t-far');
            expect(result[0].etaSource).toMatch(/^(haversine|google_api|cache)$/);
        });

        it('should produce reasonable ETA values (not absurd)', async () => {
            const result = await candidateScorerService.scoreAndRank(
                testCandidates, PICKUP_LAT, PICKUP_LNG
            );

            for (const candidate of result) {
                // ETA should be between 30 seconds and 2 hours for city distances
                expect(candidate.etaSeconds).toBeGreaterThan(30);
                expect(candidate.etaSeconds).toBeLessThan(7200);
            }
        });
    });
});
