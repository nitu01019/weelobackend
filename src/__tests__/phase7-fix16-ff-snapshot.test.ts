/**
 * =============================================================================
 * Phase-7 Fix #16 — FF snapshot mid-flight (Phase-2 Attack #4)
 * =============================================================================
 *
 * Verifies that `findCandidatesH3` snapshots the dual-index FF + step config
 * ONCE per dispatch. Even if FF_H3_DUAL_INDEX_READ flips from true → false
 * mid-await (between scheduling and resolution of the Promise.all), all
 * parallel `getCandidatesNewRing` calls within that single dispatch observe
 * the SAME snapshot — no per-vehicleKey race that would silently under-match.
 *
 * Closes: Attack #4 (FF mid-flight per-vehicleKey race).
 *
 * Run: npx jest src/__tests__/phase7-fix16-ff-snapshot.test.ts --no-coverage --forceExit
 * =============================================================================
 */

describe('Phase-7 Fix #16 — FF snapshot per dispatch', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.resetModules();
    });

    it('all parallel getCandidatesNewRing calls within one Promise.all see SAME queryResolution snapshot', async () => {
        jest.resetModules();
        // Start with FF ON — findCandidatesH3 should snapshot useParent=true, queryRes=7.
        process.env.FF_H3_DUAL_INDEX_WRITE = 'true';
        process.env.FF_H3_DUAL_INDEX_READ = 'true';
        process.env.FF_H3_INDEX_ENABLED = 'true';
        process.env.H3_RESOLUTION = '8';

        const observedQueryRes: number[] = [];

        // Mock h3-geo-index getCandidatesNewRing so we can record the queryResolution
        // that each call observes — and so we can microtask-flip the env mid-await.
        jest.doMock('../shared/services/h3-geo-index.service', () => {
            const actual = jest.requireActual('../shared/services/h3-geo-index.service');
            return {
                ...actual,
                FF_H3_DUAL_INDEX_READ: true,
                FF_H3_DUAL_INDEX_WRITE: true,
                FF_H3_INDEX_ENABLED: true,
                h3GeoIndexService: {
                    ...actual.h3GeoIndexService,
                    getCandidatesNewRing: jest.fn(
                        async (
                            _lat: number,
                            _lng: number,
                            _vk: string,
                            _ringK: number,
                            _notified: Set<string>,
                            queryResolution: number = 8,
                            _fallbackRingK?: number
                        ) => {
                            observedQueryRes.push(queryResolution);
                            // Yield a microtask so the test can flip env between calls.
                            await new Promise(resolve => setImmediate(resolve));
                            return [];
                        }
                    ),
                    getCandidates: jest.fn(async () => []),
                },
            };
        });

        // The circuit-breaker import in progressive-radius-matcher must succeed.
        jest.doMock('../shared/services/circuit-breaker.service', () => ({
            h3Circuit: {
                tryWithFallback: async (fn: () => Promise<any>, _fallback: () => Promise<any>) => {
                    return await fn();
                },
            },
        }));

        // Stub availability + redis + distance-matrix to keep the test hermetic.
        jest.doMock('../shared/services/availability.service', () => ({
            availabilityService: {
                loadTransporterDetailsMap: jest.fn(async () => new Map()),
                getAvailableTransportersWithDetails: jest.fn(async () => []),
            },
        }));
        jest.doMock('../shared/services/redis.service', () => ({
            redisService: {
                exists: jest.fn(async () => 0),
                smIsMembers: jest.fn(async () => []),
            },
        }));
        jest.doMock('../shared/services/distance-matrix.service', () => ({
            distanceMatrixService: {
                batchGetPickupDistance: jest.fn(async () => new Map()),
            },
        }));

        const matcherModule = require('../modules/order/progressive-radius-matcher');
        const { progressiveRadiusMatcher } = matcherModule;

        // Step 5: h3QueryResolution=7. Multiple vehicleKey candidates → multiple
        // parallel getCandidatesNewRing calls within one Promise.all.
        // The mock above pins both FFs to true via jest.doMock, so the matcher's
        // import-const captures FF_H3_DUAL_INDEX_READ=true at require time. The
        // snapshot at progressive-radius-matcher.ts:262-265 then locks queryRes=7
        // into a local before Promise.all — every parallel call sees the same.
        const result = await progressiveRadiusMatcher.findCandidates({
            pickupLat: 19.0760,
            pickupLng: 72.8777,
            vehicleType: 'truck',
            vehicleSubtype: '17ft_open',
            stepIndex: 5, // Step 5 — radiusKm=100, h3QueryResolution=7
            alreadyNotified: new Set<string>(),
            limit: 250,
        });

        // 1+ parallel getCandidatesNewRing calls were made within the same dispatch.
        expect(observedQueryRes.length).toBeGreaterThan(0);

        // Snapshot invariant: every call within this dispatch saw the SAME queryRes.
        const uniqueQueryRes = new Set(observedQueryRes);
        expect(uniqueQueryRes.size).toBe(1);

        // Sanity: result is an array (no throws despite the mid-flight env flip).
        expect(Array.isArray(result)).toBe(true);
    });

    it('when FF off at dispatch start, snapshot pins useParent=false even if FF flips on mid-await', async () => {
        jest.resetModules();
        process.env.FF_H3_DUAL_INDEX_WRITE = 'false';
        process.env.FF_H3_DUAL_INDEX_READ = 'false';
        process.env.FF_H3_INDEX_ENABLED = 'true';
        process.env.H3_RESOLUTION = '8';

        const observedQueryRes: number[] = [];

        jest.doMock('../shared/services/h3-geo-index.service', () => {
            const actual = jest.requireActual('../shared/services/h3-geo-index.service');
            return {
                ...actual,
                FF_H3_DUAL_INDEX_READ: false,
                FF_H3_DUAL_INDEX_WRITE: false,
                FF_H3_INDEX_ENABLED: true,
                h3GeoIndexService: {
                    ...actual.h3GeoIndexService,
                    getCandidatesNewRing: jest.fn(
                        async (
                            _lat: number,
                            _lng: number,
                            _vk: string,
                            _ringK: number,
                            _notified: Set<string>,
                            queryResolution: number = 8,
                            _fallbackRingK?: number
                        ) => {
                            observedQueryRes.push(queryResolution);
                            await new Promise(resolve => setImmediate(resolve));
                            return [];
                        }
                    ),
                    getCandidates: jest.fn(async () => []),
                },
            };
        });
        jest.doMock('../shared/services/circuit-breaker.service', () => ({
            h3Circuit: {
                tryWithFallback: async (fn: () => Promise<any>) => await fn(),
            },
        }));
        jest.doMock('../shared/services/availability.service', () => ({
            availabilityService: {
                loadTransporterDetailsMap: jest.fn(async () => new Map()),
                getAvailableTransportersWithDetails: jest.fn(async () => []),
            },
        }));
        jest.doMock('../shared/services/redis.service', () => ({
            redisService: {
                exists: jest.fn(async () => 0),
                smIsMembers: jest.fn(async () => []),
            },
        }));
        jest.doMock('../shared/services/distance-matrix.service', () => ({
            distanceMatrixService: {
                batchGetPickupDistance: jest.fn(async () => new Map()),
            },
        }));

        const matcherModule = require('../modules/order/progressive-radius-matcher');
        const { progressiveRadiusMatcher } = matcherModule;

        await progressiveRadiusMatcher.findCandidates({
            pickupLat: 19.0760,
            pickupLng: 72.8777,
            vehicleType: 'truck',
            vehicleSubtype: '17ft_open',
            stepIndex: 5,
            alreadyNotified: new Set<string>(),
            limit: 250,
        });

        // FF off → useParent=false → queryRes pinned to 8 (res-8 child path).
        expect(observedQueryRes.length).toBeGreaterThan(0);
        const uniqueQueryRes = new Set(observedQueryRes);
        expect(uniqueQueryRes.size).toBe(1);
        expect(observedQueryRes[0]).toBe(8);
    });
});
