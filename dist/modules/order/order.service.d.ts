/**
 * =============================================================================
 * ORDER SERVICE - Multi-Vehicle Type Booking System
 * =============================================================================
 *
 * SCALABILITY: Designed for millions of concurrent bookings
 * - Each order can have multiple vehicle types (Tipper + Container + Open)
 * - Each vehicle type creates a separate SubRequest
 * - Each SubRequest broadcasts ONLY to transporters with that vehicle type
 *
 * FLOW:
 * 1. Customer creates ORDER with multiple vehicle types
 * 2. System creates TruckRequests (one per truck, grouped by type)
 * 3. Each vehicle type broadcasts to matching transporters
 * 4. Transporters see ONLY requests matching their vehicles
 * 5. Real-time updates to customer as trucks get filled
 *
 * MODULARITY:
 * - Clear separation: Order → TruckRequests → Assignments
 * - Easy to extend for new vehicle types
 * - AWS-ready with message queue support (TODO)
 * =============================================================================
 */
import { OrderRecord, TruckRequestRecord } from '../../shared/database/db';
/**
 * Vehicle requirement in a booking
 * Customer can request multiple types in one booking
 */
export interface VehicleRequirement {
    vehicleType: string;
    vehicleSubtype: string;
    quantity: number;
    pricePerTruck: number;
}
/**
 * Create order request from customer app
 */
export interface CreateOrderRequest {
    customerId: string;
    customerName: string;
    customerPhone: string;
    pickup: {
        latitude: number;
        longitude: number;
        address: string;
        city?: string;
        state?: string;
    };
    drop: {
        latitude: number;
        longitude: number;
        address: string;
        city?: string;
        state?: string;
    };
    distanceKm: number;
    vehicleRequirements: VehicleRequirement[];
    goodsType?: string;
    cargoWeightKg?: number;
    scheduledAt?: string;
}
/**
 * Response after creating order
 */
export interface CreateOrderResponse {
    orderId: string;
    totalTrucks: number;
    totalAmount: number;
    truckRequests: {
        id: string;
        vehicleType: string;
        vehicleSubtype: string;
        quantity: number;
        pricePerTruck: number;
        matchingTransporters: number;
    }[];
    expiresAt: string;
}
declare class OrderService {
    private readonly BROADCAST_TIMEOUT_MS;
    private orderTimers;
    /**
     * Get transporters by vehicle type (CACHED + AVAILABILITY FILTERED)
     * Uses cache to avoid repeated DB queries during high-load broadcasts
     *
     * IMPORTANT: Only returns transporters who are:
     * 1. Have matching vehicle type
     * 2. Are marked as "available" (online toggle is ON)
     */
    private getTransportersByVehicleCached;
    /**
     * Invalidate transporter cache when vehicles change
     */
    invalidateTransporterCache(vehicleType: string, vehicleSubtype?: string): Promise<void>;
    /**
     * Create a new order with multiple vehicle types
     *
     * SCALABILITY NOTES:
     * - For millions of users, this should be moved to a message queue
     * - Each vehicle type can be processed in parallel
     * - Database writes should be batched
     */
    createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse>;
    /**
     * Broadcast truck requests to matching transporters
     *
     * KEY: Each vehicle type goes ONLY to transporters with that type
     */
    private broadcastToTransporters;
    /**
     * Send push notifications asynchronously
     * Does not block the main flow
     */
    private sendPushNotificationsAsync;
    /**
     * Set timer to expire order after timeout
     */
    private setOrderExpiryTimer;
    /**
     * Handle order expiry
     * Mark unfilled truck requests as expired
     */
    private handleOrderExpiry;
    /**
     * Accept a truck request (transporter assigns vehicle + driver)
     *
     * Called when transporter accepts from the Captain app
     */
    acceptTruckRequest(truckRequestId: string, transporterId: string, vehicleId: string, driverId: string): Promise<{
        success: boolean;
        assignmentId?: string;
        tripId?: string;
        message: string;
    }>;
    /**
     * Get order details with all truck requests
     */
    getOrderDetails(orderId: string): OrderRecord & {
        truckRequests: TruckRequestRecord[];
    } | null;
    /**
     * Get active truck requests for a transporter
     * Returns ONLY requests matching their vehicle types
     */
    getActiveRequestsForTransporter(transporterId: string): TruckRequestRecord[];
    /**
     * Get orders by customer
     */
    getOrdersByCustomer(customerId: string): OrderRecord[];
}
export declare const orderService: OrderService;
export {};
//# sourceMappingURL=order.service.d.ts.map