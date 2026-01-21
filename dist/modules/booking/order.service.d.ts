/**
 * =============================================================================
 * ORDER SERVICE - Multi-Truck Request System
 * =============================================================================
 *
 * OPTIMIZED ALGORITHM:
 *
 * 1. Customer selects: 2x Open 17ft + 3x Container 4ton
 * 2. System creates 1 Order (parent) + 5 TruckRequests (children)
 * 3. Requests are grouped by vehicle type for efficient broadcasting
 * 4. Each group is broadcast to matching transporters in parallel
 * 5. Transporters only see requests matching their truck types
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Batch DB operations
 * - Parallel WebSocket emissions
 * - Grouped broadcasts (less network calls)
 * - Efficient transporter matching using Set lookups
 *
 * SCALABILITY: Designed for millions of concurrent users
 * =============================================================================
 */
import { OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { CreateOrderInput } from './booking.schema';
interface CreateOrderResult {
    order: OrderRecord;
    truckRequests: TruckRequestRecord[];
    broadcastSummary: {
        totalRequests: number;
        groupedBy: {
            vehicleType: string;
            vehicleSubtype: string;
            count: number;
            transportersNotified: number;
        }[];
        totalTransportersNotified: number;
    };
    timeoutSeconds: number;
}
declare class OrderService {
    /**
     * ==========================================================================
     * CREATE ORDER - Main Entry Point
     * ==========================================================================
     *
     * ALGORITHM:
     * 1. Validate input
     * 2. Create parent Order record
     * 3. Expand truck selections into individual TruckRequest records
     * 4. Group requests by vehicle type/subtype
     * 5. Find matching transporters for each group (parallel)
     * 6. Broadcast to transporters (grouped for efficiency)
     * 7. Start timeout timer
     */
    createOrder(customerId: string, customerPhone: string, data: CreateOrderInput): Promise<CreateOrderResult>;
    /**
     * Expand truck selections into individual TruckRequest records
     *
     * Input:  [{ vehicleType: "open", subtype: "17ft", quantity: 2 }]
     * Output: [TruckRequest#1, TruckRequest#2] (2 separate requests)
     */
    private expandTruckSelections;
    /**
     * Group requests by vehicle type/subtype for efficient broadcasting
     *
     * This reduces the number of transporter lookups and WebSocket emissions
     */
    private groupRequestsByVehicleType;
    /**
     * Broadcast to transporters - the core matching algorithm
     *
     * OPTIMIZED:
     * - Finds transporters for each vehicle type group in parallel
     * - Sends grouped notifications (less WebSocket calls)
     * - Updates notifiedTransporters in batch
     */
    private broadcastToTransporters;
    /**
     * Start timeout timer for order
     */
    private startOrderTimeout;
    /**
     * Handle order timeout
     */
    private handleOrderTimeout;
    /**
     * Start countdown notifications
     */
    private startCountdownNotifications;
    /**
     * Clear all timers for an order
     */
    private clearOrderTimers;
    /**
     * Cancel order timeout (called when fully filled)
     */
    cancelOrderTimeout(orderId: string): void;
    /**
     * Accept a truck request (transporter assigns their truck)
     *
     * LIGHTNING FAST FLOW:
     * 1. Validate request is still available (atomic check)
     * 2. Update request status immediately
     * 3. Send confirmation to accepting transporter
     * 4. Update remaining count for all other transporters
     * 5. Notify customer with progress update
     *
     * HANDLES: 10 same truck type → 10 transporters get notified → Each can accept 1
     */
    acceptTruckRequest(requestId: string, transporterId: string, vehicleId: string, driverId?: string): Promise<TruckRequestRecord>;
    /**
     * Get order by ID with all truck requests
     */
    getOrderWithRequests(orderId: string, userId: string, userRole: string): Promise<{
        order: OrderRecord;
        requests: TruckRequestRecord[];
        summary: {
            totalTrucks: number;
            trucksFilled: number;
            trucksSearching: number;
            trucksExpired: number;
        };
    }>;
    /**
     * Get active truck requests for transporter (only matching their vehicle types)
     */
    getActiveTruckRequestsForTransporter(transporterId: string): Promise<{
        order: OrderRecord | undefined;
        requests: TruckRequestRecord[];
    }[]>;
    /**
     * Get customer's orders
     */
    getCustomerOrders(customerId: string, page?: number, limit?: number): Promise<{
        orders: {
            requestsSummary: {
                total: number;
                searching: number;
                assigned: number;
                completed: number;
                expired: number;
            };
            id: string;
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
            totalTrucks: number;
            trucksFilled: number;
            totalAmount: number;
            goodsType?: string;
            weight?: string;
            cargoWeightKg?: number;
            status: "active" | "partially_filled" | "fully_filled" | "in_progress" | "completed" | "cancelled" | "expired";
            scheduledAt?: string;
            expiresAt: string;
            createdAt: string;
            updatedAt: string;
        }[];
        total: number;
        hasMore: boolean;
    }>;
}
export declare const orderService: OrderService;
export {};
//# sourceMappingURL=order.service.d.ts.map