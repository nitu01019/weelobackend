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
 * Location payload sent inside broadcast events.
 */
export interface BroadcastLocation {
    address: string;
    city?: string;
    latitude: number;
    longitude: number;
}

/**
 * Per-vehicle-type entry in the requestedVehicles array.
 */
export interface BroadcastRequestedVehicle {
    vehicleType: string;
    vehicleSubtype: string;
    count: number;
    filledCount: number;
    farePerTruck: number;
    capacityTons: number;
}

/**
 * Full broadcast payload emitted via `new_broadcast` Socket.IO events.
 * Captain app expects this exact shape — see SocketIOService.kt.
 */
export interface BroadcastPayload {
    // IDs
    broadcastId: string;
    orderId: string;
    bookingId: string;

    // Customer
    customerId: string;
    customerName: string;

    // Vehicle
    vehicleType: string;
    vehicleSubtype: string;
    trucksNeeded: number;
    totalTrucksNeeded: number;
    trucksFilled: number;
    trucksFilledSoFar: number;

    // Pricing
    pricePerTruck: number;
    farePerTruck: number;
    totalFare: number;

    // Nested location format (for Captain app)
    pickupLocation: BroadcastLocation;
    dropLocation: BroadcastLocation;

    // Flat format (legacy compatibility)
    pickupAddress: string;
    pickupCity?: string;
    dropAddress: string;
    dropCity?: string;

    // Distance / Cargo
    distanceKm: number;
    distance: number;
    goodsType?: string;
    weight?: string;

    // Per-transporter pickup proximity
    pickupDistanceKm: number;
    pickupEtaMinutes: number;
    // H-8 FIX: Unified ETA — seconds is the new standard, minutes kept for backward compat
    pickupEtaSeconds: number;

    // Timing
    createdAt: string;
    expiresAt: string;
    timeoutSeconds: number;

    // Flags
    isUrgent: boolean;
    isRebroadcast?: boolean;
    radiusStep?: number;

    // H-8 FIX: Payload version — lets Captain app know which fields to expect
    payloadVersion: number;

    // Multi-truck UI compatibility array
    requestedVehicles: BroadcastRequestedVehicle[];
}

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
        pickupDistanceKm?: number;  // How far THIS transporter is from pickup
        pickupEtaMinutes?: number;  // ETA for THIS transporter to reach pickup
        pickupEtaSeconds?: number;  // ETA in seconds (preferred precision)
    }
): BroadcastPayload {
    const trucksFilled = options?.trucksFilled ?? booking.trucksFilled;

    // H-8 FIX: Unified ETA — derive seconds from minutes if not provided, or vice versa
    const etaMinutes = options?.pickupEtaMinutes ?? 0;
    const etaSeconds = options?.pickupEtaSeconds ?? (etaMinutes * 60);

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

        // Per-transporter pickup proximity (0 = unknown, e.g. DB fallback)
        pickupDistanceKm: options?.pickupDistanceKm ?? 0,
        // H-8 FIX: Both fields present for backward compatibility
        // pickupEtaMinutes: DEPRECATED but kept for old Captain app versions
        // pickupEtaSeconds: NEW standard field (precise)
        pickupEtaMinutes: etaMinutes,
        pickupEtaSeconds: etaSeconds,

        // Timing
        createdAt: booking.createdAt,
        expiresAt: booking.expiresAt,
        timeoutSeconds: options?.timeoutSeconds ?? 0,

        // Flags
        isUrgent: false,
        ...(options?.isRebroadcast ? { isRebroadcast: true } : {}),
        ...(options?.radiusStep ? { radiusStep: options.radiusStep } : {}),

        // H-8 FIX: Payload version — lets Captain app detect new format
        payloadVersion: 2,

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
