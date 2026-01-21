/**
 * =============================================================================
 * BROADCAST MODULE - SERVICE
 * =============================================================================
 *
 * Business logic for broadcast management.
 * Broadcasts are booking requests sent to drivers/transporters.
 *
 * =============================================================================
 */
interface GetActiveBroadcastsParams {
    driverId: string;
    vehicleType?: string;
    maxDistance?: number;
}
interface AcceptBroadcastParams {
    driverId: string;
    vehicleId: string;
    estimatedArrival?: string;
    notes?: string;
}
interface DeclineBroadcastParams {
    driverId: string;
    reason: string;
    notes?: string;
}
interface GetHistoryParams {
    driverId: string;
    page: number;
    limit: number;
    status?: string;
}
interface CreateBroadcastParams {
    transporterId: string;
    customerId: string;
    pickupLocation: {
        latitude: number;
        longitude: number;
        address: string;
        city: string;
        state: string;
        pincode: string;
    };
    dropLocation: {
        latitude: number;
        longitude: number;
        address: string;
        city: string;
        state: string;
        pincode: string;
    };
    vehicleType: string;
    vehicleSubtype?: string;
    totalTrucksNeeded: number;
    goodsType: string;
    weight: string;
    farePerTruck: number;
    isUrgent?: boolean;
    expiresAt?: string;
    preferredDriverIds?: string[];
}
declare class BroadcastService {
    /**
     * Get active broadcasts for a driver
     * Returns bookings that are still looking for trucks
     */
    getActiveBroadcasts(params: GetActiveBroadcastsParams): Promise<{
        broadcastId: string;
        customerId: string;
        customerName: string;
        customerMobile: string;
        pickupLocation: {
            latitude: number;
            longitude: number;
            address: string;
            city?: string;
            state?: string;
        };
        dropLocation: {
            latitude: number;
            longitude: number;
            address: string;
            city?: string;
            state?: string;
        };
        distance: number;
        estimatedDuration: number;
        totalTrucksNeeded: number;
        trucksFilledSoFar: number;
        vehicleType: string;
        vehicleSubtype: string;
        goodsType: string;
        weight: string;
        farePerTruck: number;
        totalFare: number;
        status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
        isUrgent: boolean;
        createdAt: string;
        expiresAt: string;
        capacityInfo: {
            capacityKg: any;
            capacityTons: number;
            minTonnage: any;
            maxTonnage: any;
        } | null;
    }[]>;
    /**
     * Get broadcast by ID
     */
    getBroadcastById(broadcastId: string): Promise<{
        broadcastId: string;
        customerId: string;
        customerName: string;
        customerMobile: string;
        pickupLocation: {
            latitude: number;
            longitude: number;
            address: string;
            city?: string;
            state?: string;
        };
        dropLocation: {
            latitude: number;
            longitude: number;
            address: string;
            city?: string;
            state?: string;
        };
        distance: number;
        estimatedDuration: number;
        totalTrucksNeeded: number;
        trucksFilledSoFar: number;
        vehicleType: string;
        vehicleSubtype: string;
        goodsType: string;
        weight: string;
        farePerTruck: number;
        totalFare: number;
        status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
        isUrgent: boolean;
        createdAt: string;
        expiresAt: string;
        capacityInfo: {
            capacityKg: any;
            capacityTons: number;
            minTonnage: any;
            maxTonnage: any;
        } | null;
    }>;
    /**
     * Accept a broadcast (assign driver/vehicle to booking)
     *
     * FLOW:
     * 1. Validate booking is still available
     * 2. Create assignment record
     * 3. Update booking status
     * 4. Notify DRIVER via WebSocket + Push (trip assignment)
     * 5. Notify CUSTOMER via WebSocket (real-time confirmation)
     *
     * SCALABILITY:
     * - Uses async notifications (non-blocking)
     * - Idempotent - safe to retry
     * - Transaction-safe with database
     */
    acceptBroadcast(broadcastId: string, params: AcceptBroadcastParams): Promise<{
        assignmentId: string;
        tripId: string;
        status: string;
        trucksConfirmed: number;
        totalTrucksNeeded: number;
        isFullyFilled: boolean;
    }>;
    /**
     * Decline a broadcast
     */
    declineBroadcast(broadcastId: string, params: DeclineBroadcastParams): Promise<{
        success: boolean;
    }>;
    /**
     * Get broadcast history for a driver
     */
    getBroadcastHistory(params: GetHistoryParams): Promise<{
        broadcasts: {
            broadcastId: string;
            customerId: string;
            customerName: string;
            customerMobile: string;
            pickupLocation: {
                latitude: number;
                longitude: number;
                address: string;
                city?: string;
                state?: string;
            };
            dropLocation: {
                latitude: number;
                longitude: number;
                address: string;
                city?: string;
                state?: string;
            };
            distance: number;
            estimatedDuration: number;
            totalTrucksNeeded: number;
            trucksFilledSoFar: number;
            vehicleType: string;
            vehicleSubtype: string;
            goodsType: string;
            weight: string;
            farePerTruck: number;
            totalFare: number;
            status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
            isUrgent: boolean;
            createdAt: string;
            expiresAt: string;
            capacityInfo: {
                capacityKg: any;
                capacityTons: number;
                minTonnage: any;
                maxTonnage: any;
            } | null;
        }[];
        pagination: {
            page: number;
            limit: number;
            total: number;
            pages: number;
        };
    }>;
    /**
     * Create a new broadcast (from transporter)
     */
    createBroadcast(params: CreateBroadcastParams): Promise<{
        broadcast: {
            broadcastId: string;
            customerId: string;
            customerName: string;
            customerMobile: string;
            pickupLocation: {
                latitude: number;
                longitude: number;
                address: string;
                city?: string;
                state?: string;
            };
            dropLocation: {
                latitude: number;
                longitude: number;
                address: string;
                city?: string;
                state?: string;
            };
            distance: number;
            estimatedDuration: number;
            totalTrucksNeeded: number;
            trucksFilledSoFar: number;
            vehicleType: string;
            vehicleSubtype: string;
            goodsType: string;
            weight: string;
            farePerTruck: number;
            totalFare: number;
            status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
            isUrgent: boolean;
            createdAt: string;
            expiresAt: string;
            capacityInfo: {
                capacityKg: any;
                capacityTons: number;
                minTonnage: any;
                maxTonnage: any;
            } | null;
        };
        notifiedDrivers: number;
    }>;
    /**
     * Map internal booking to broadcast format for API response
     * Enhanced with capacity/tonnage information
     */
    private mapBookingToBroadcast;
}
export declare const broadcastService: BroadcastService;
export {};
//# sourceMappingURL=broadcast.service.d.ts.map