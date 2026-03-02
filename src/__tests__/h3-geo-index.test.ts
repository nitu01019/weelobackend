/**
 * =============================================================================
 * H3 GEO-INDEX SERVICE — Unit Tests
 * =============================================================================
 *
 * Tests the H3 hexagonal geo-index used for transporter candidate lookup.
 * These tests use the InMemoryRedisClient (no real Redis needed).
 *
 * Run: npx jest --testPathPattern="h3-geo-index" --forceExit
 * =============================================================================
 */

import { h3GeoIndexService } from '../shared/services/h3-geo-index.service';

// Use a well-known location for tests: Delhi (28.6139, 77.2090)
const DELHI_LAT = 28.6139;
const DELHI_LNG = 77.2090;

// A location ~2km from Delhi center
const NEARBY_LAT = 28.6300;
const NEARBY_LNG = 77.2200;

// A location ~50km from Delhi center (Gurgaon)
const FAR_LAT = 28.4595;
const FAR_LNG = 77.0266;

describe('H3GeoIndexService', () => {
    afterEach(async () => {
        // Clean up — remove test transporters
        await h3GeoIndexService.removeTransporter('t-100');
        await h3GeoIndexService.removeTransporter('t-200');
        await h3GeoIndexService.removeTransporter('t-300');
        await h3GeoIndexService.removeTransporter('t-400');
    });

    describe('latLngToCell', () => {
        it('should convert lat/lng to a valid H3 cell ID', () => {
            const cell = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            expect(cell).toBeTruthy();
            expect(typeof cell).toBe('string');
            expect(cell.length).toBeGreaterThan(5);
        });

        it('should return different cells for distant locations', () => {
            const cell1 = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const cell2 = h3GeoIndexService.latLngToCell(FAR_LAT, FAR_LNG);
            expect(cell1).not.toBe(cell2);
        });

        it('should return the same cell for nearby points within cell boundary', () => {
            // Two points very close together (< 100m) should be in same cell
            const cell1 = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const cell2 = h3GeoIndexService.latLngToCell(DELHI_LAT + 0.0001, DELHI_LNG + 0.0001);
            expect(cell1).toBe(cell2);
        });
    });

    describe('gridDisk', () => {
        it('should return just the origin cell for k=0', () => {
            const cell = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const disk = h3GeoIndexService.gridDisk(cell, 0);
            expect(disk).toHaveLength(1);
            expect(disk[0]).toBe(cell);
        });

        it('should return 7 cells for k=1 (origin + 6 neighbors)', () => {
            const cell = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const disk = h3GeoIndexService.gridDisk(cell, 1);
            expect(disk).toHaveLength(7);
            expect(disk).toContain(cell);
        });

        it('should return increasing cell counts for larger rings', () => {
            const cell = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const disk1 = h3GeoIndexService.gridDisk(cell, 1);
            const disk2 = h3GeoIndexService.gridDisk(cell, 2);
            expect(disk2.length).toBeGreaterThan(disk1.length);
        });
    });

    describe('addTransporter / removeTransporter', () => {
        it('should add a transporter and find it via getCandidates', async () => {
            await h3GeoIndexService.addTransporter('t-100', DELHI_LAT, DELHI_LNG, 'open_17ft');

            const candidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 0, new Set()
            );

            expect(candidates).toContain('t-100');
        });

        it('should not find a transporter after removal', async () => {
            await h3GeoIndexService.addTransporter('t-100', DELHI_LAT, DELHI_LNG, 'open_17ft');
            await h3GeoIndexService.removeTransporter('t-100');

            const candidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 0, new Set()
            );

            expect(candidates).not.toContain('t-100');
        });

        it('should not find a transporter with wrong vehicle key', async () => {
            await h3GeoIndexService.addTransporter('t-100', DELHI_LAT, DELHI_LNG, 'open_17ft');

            const candidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'container_20ft', 0, new Set()
            );

            expect(candidates).not.toContain('t-100');
        });
    });

    describe('addTransporterMulti', () => {
        it('should index a transporter under multiple vehicle keys', async () => {
            await h3GeoIndexService.addTransporterMulti('t-200', DELHI_LAT, DELHI_LNG, ['open_17ft', 'open_22ft']);

            const candidates17ft = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 0, new Set()
            );
            const candidates22ft = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_22ft', 0, new Set()
            );

            expect(candidates17ft).toContain('t-200');
            expect(candidates22ft).toContain('t-200');
        });
    });

    describe('updateLocation', () => {
        it('should move a transporter between cells when location changes significantly', async () => {
            await h3GeoIndexService.addTransporter('t-300', DELHI_LAT, DELHI_LNG, 'open_17ft');

            // Move to a far location (different cell)
            await h3GeoIndexService.updateLocation('t-300', FAR_LAT, FAR_LNG, ['open_17ft']);

            // Should NOT be found at old location (origin cell only)
            const oldCandidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 0, new Set()
            );
            expect(oldCandidates).not.toContain('t-300');

            // Should be found at new location
            const newCandidates = await h3GeoIndexService.getCandidates(
                FAR_LAT, FAR_LNG, 'open_17ft', 0, new Set()
            );
            expect(newCandidates).toContain('t-300');
        });
    });

    describe('getCandidates', () => {
        it('should find nearby transporters with ring expansion', async () => {
            // Add a transporter ~2km away
            await h3GeoIndexService.addTransporter('t-100', NEARBY_LAT, NEARBY_LNG, 'open_17ft');

            // Ring 0 might not find it (different cell)
            // Ring 5 (~3.5km) should definitely find it
            const candidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 5, new Set()
            );

            expect(candidates).toContain('t-100');
        });

        it('should exclude already-notified transporters', async () => {
            await h3GeoIndexService.addTransporter('t-100', DELHI_LAT, DELHI_LNG, 'open_17ft');
            await h3GeoIndexService.addTransporter('t-200', DELHI_LAT + 0.001, DELHI_LNG, 'open_17ft');

            const alreadyNotified = new Set(['t-100']);
            const candidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 2, alreadyNotified
            );

            expect(candidates).not.toContain('t-100');
        });

        it('should handle multiple transporters in same cell', async () => {
            await h3GeoIndexService.addTransporter('t-100', DELHI_LAT, DELHI_LNG, 'open_17ft');
            await h3GeoIndexService.addTransporter('t-200', DELHI_LAT, DELHI_LNG, 'open_17ft');
            await h3GeoIndexService.addTransporter('t-300', DELHI_LAT, DELHI_LNG, 'open_17ft');

            const candidates = await h3GeoIndexService.getCandidates(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 0, new Set()
            );

            expect(candidates).toHaveLength(3);
            expect(candidates).toContain('t-100');
            expect(candidates).toContain('t-200');
            expect(candidates).toContain('t-300');
        });
    });

    describe('getCandidatesNewRing', () => {
        it('should return only candidates from the outer ring, not inner cells', async () => {
            // Add transporter at same cell (ring 0)
            await h3GeoIndexService.addTransporter('t-100', DELHI_LAT, DELHI_LNG, 'open_17ft');
            // Add transporter nearby but in a different cell (rings 1-2)
            await h3GeoIndexService.addTransporter('t-200', NEARBY_LAT, NEARBY_LNG, 'open_17ft');

            // Ring 0 should find t-100 only
            const ring0 = await h3GeoIndexService.getCandidatesNewRing(
                DELHI_LAT, DELHI_LNG, 'open_17ft', 0, new Set()
            );
            expect(ring0).toContain('t-100');
        });
    });

    describe('getApproxDistanceKm', () => {
        it('should return 0 for same cell', () => {
            const cell = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const dist = h3GeoIndexService.getApproxDistanceKm(cell, cell);
            expect(dist).toBe(0);
        });

        it('should return positive distance for different cells', () => {
            const cell1 = h3GeoIndexService.latLngToCell(DELHI_LAT, DELHI_LNG);
            const cell2 = h3GeoIndexService.latLngToCell(NEARBY_LAT, NEARBY_LNG);
            const dist = h3GeoIndexService.getApproxDistanceKm(cell1, cell2);
            expect(dist).toBeGreaterThan(0);
        });
    });
});
