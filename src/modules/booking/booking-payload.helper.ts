/**
 * =============================================================================
 * BOOKING MODULE - BROADCAST PAYLOAD BUILDER
 * =============================================================================
 * 
 * Extracts the broadcast payload construction into a single reusable helper.
 * Eliminates duplicate payload construction across:
 *   - createBooking (initial broadcast)
 *   - advanceRadiusStep (expansion broadcasts)
 *   - radiusDbFallback (DB fallback broadcast)
 *   - deliverMissedBroadcasts (re-broadcast on toggle)
 * 
 * IMPORTANT: Any change to the payload format MUST be made here only.
 * =============================================================================
 */

import { BookingRecord } from '../../shared/database/db';

/**
 * Builds the standard broadcast payload from a BookingRecord.
 * 
 * Used by every code path that emits `new_broadcast` events.
 * Captain app expects this exact format — see SocketIOService.kt.
 * 
 * @param booking  - The booking record from DB
 * @param options  - Override fields (e.g. timeoutSeconds, isRebroadcast, radiusStep)
 */
export function buildBroadcastPayload(
    booking: BookingRecord,
    options?: {
        timeoutSeconds?: number;
        isRebroadcast?: boolean;
        radiusStep?: number;
        trucksFilled?: number;  // Override if stale in record
    }
): Record<string, any> {
    const trucksFilled = options?.trucksFilled ?? booking.trucksFilled;

    return {
        // IDs (Captain app checks broadcastId first, then orderId)
        broadcastId: booking.id,
        orderId: booking.id,
        bookingId: booking.id,

        // Customer
        customerId: booking.customerId,
        customerName: booking.customerName,

        // Vehicle
        vehicleType: booking.vehicleType,
        vehicleSubtype: booking.vehicleSubtype,
        trucksNeeded: booking.trucksNeeded,
        totalTrucksNeeded: booking.trucksNeeded,
        trucksFilled,
        trucksFilledSoFar: trucksFilled,

        // Pricing
        pricePerTruck: booking.pricePerTruck,
        farePerTruck: booking.pricePerTruck,
        totalFare: booking.totalAmount,

        // Nested location format (for Captain app)
        pickupLocation: {
            address: booking.pickup.address,
            city: booking.pickup.city,
            latitude: booking.pickup.latitude,
            longitude: booking.pickup.longitude
        },
        dropLocation: {
            address: booking.drop.address,
            city: booking.drop.city,
            latitude: booking.drop.latitude,
            longitude: booking.drop.longitude
        },

        // Flat format (legacy compatibility)
        pickupAddress: booking.pickup.address,
        pickupCity: booking.pickup.city,
        dropAddress: booking.drop.address,
        dropCity: booking.drop.city,

        // Distance / Cargo
        distanceKm: booking.distanceKm,
        distance: booking.distanceKm,
        goodsType: booking.goodsType,
        weight: booking.weight,

        // Timing
        createdAt: booking.createdAt,
        expiresAt: booking.expiresAt,
        timeoutSeconds: options?.timeoutSeconds ?? 0,

        // Flags
        isUrgent: false,
        ...(options?.isRebroadcast ? { isRebroadcast: true } : {}),
        ...(options?.radiusStep ? { radiusStep: options.radiusStep } : {}),

        // Multi-truck UI compatibility array
        requestedVehicles: [{
            vehicleType: booking.vehicleType,
            vehicleSubtype: booking.vehicleSubtype || '',
            count: booking.trucksNeeded,
            filledCount: trucksFilled,
            farePerTruck: booking.pricePerTruck,
            capacityTons: 0
        }]
    };
}

/**
 * Calculate remaining timeout seconds from booking expiresAt.
 * Returns 0 if already expired.
 */
export function getRemainingTimeoutSeconds(booking: BookingRecord, fallbackMs: number): number {
    if (!booking.expiresAt) return Math.floor(fallbackMs / 1000);
    const remaining = new Date(booking.expiresAt).getTime() - Date.now();
    return Math.max(0, Math.floor(remaining / 1000));
}
