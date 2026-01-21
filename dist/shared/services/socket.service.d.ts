/**
 * =============================================================================
 * SOCKET SERVICE - Real-time Communication
 * =============================================================================
 *
 * Handles WebSocket connections for real-time updates:
 * - New booking notifications to matching transporters
 * - Booking status updates to customers
 * - Location tracking updates
 * - Assignment status changes
 *
 * SECURITY:
 * - JWT authentication required
 * - Room-based isolation
 * - Users only receive their own data
 * =============================================================================
 */
import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
/**
 * Socket Events
 *
 * ENHANCED: Added booking lifecycle events for timeout handling
 * ENHANCED: Added real-time truck count updates for multi-truck requests
 */
export declare const SocketEvent: {
    CONNECTED: string;
    BOOKING_UPDATED: string;
    TRUCK_ASSIGNED: string;
    LOCATION_UPDATED: string;
    ASSIGNMENT_STATUS_CHANGED: string;
    NEW_BROADCAST: string;
    BOOKING_EXPIRED: string;
    BOOKING_FULLY_FILLED: string;
    BOOKING_PARTIALLY_FILLED: string;
    NO_VEHICLES_AVAILABLE: string;
    BROADCAST_COUNTDOWN: string;
    TRUCK_REQUEST_ACCEPTED: string;
    TRUCKS_REMAINING_UPDATE: string;
    REQUEST_NO_LONGER_AVAILABLE: string;
    ORDER_STATUS_UPDATE: string;
    NEW_ORDER_ALERT: string;
    ACCEPT_CONFIRMATION: string;
    ERROR: string;
    JOIN_BOOKING: string;
    LEAVE_BOOKING: string;
    JOIN_ORDER: string;
    LEAVE_ORDER: string;
    UPDATE_LOCATION: string;
};
/**
 * =============================================================================
 * OPTIMIZED Socket.IO Configuration
 * =============================================================================
 *
 * OPTIMIZATIONS:
 * 1. PING/PONG: 25s interval, 20s timeout - Keeps connections alive
 * 2. PER-MESSAGE DEFLATE: Compresses messages for faster transfer
 * 3. HTTP LONG-POLLING DISABLED: WebSocket only for better performance
 * 4. MAX HTTP BUFFER SIZE: 10MB for large payloads
 * 5. CONNECTION STATE RECOVERY: Reconnection support
 * =============================================================================
 */
export declare function initializeSocket(server: HttpServer): Server;
/**
 * Emit to a specific user (by userId)
 * Used to send notifications to specific transporters
 */
export declare function emitToUser(userId: string, event: string, data: any): void;
/**
 * Emit to all sockets in a booking room
 */
export declare function emitToBooking(bookingId: string, event: string, data: any): void;
/**
 * Emit to all sockets in a trip room
 */
export declare function emitToTrip(tripId: string, event: string, data: any): void;
/**
 * Emit to all connected clients
 */
export declare function emitToAll(event: string, data: any): void;
/**
 * Get connected user count
 */
export declare function getConnectedUserCount(): number;
/**
 * Check if user is connected
 */
export declare function isUserConnected(userId: string): boolean;
/**
 * Get Socket.IO instance
 */
export declare function getIO(): Server | null;
/**
 * Emit to all sockets in an order room
 * Used for multi-truck request updates
 */
export declare function emitToOrder(orderId: string, event: string, data: any): void;
/**
 * Get detailed connection statistics
 * Useful for monitoring and debugging
 */
export declare function getConnectionStats(): ConnectionStats;
/**
 * Broadcast to multiple users efficiently
 * Used when notifying many transporters about a new order
 */
export declare function emitToUsers(userIds: string[], event: string, data: any): void;
/**
 * Emit to a specific room (e.g., booking:123, trip:456)
 * Used for group notifications like booking updates
 */
export declare function emitToRoom(room: string, event: string, data: any): void;
/**
 * Broadcast to all transporters
 * Used for system-wide announcements
 */
export declare function emitToAllTransporters(event: string, data: any): void;
interface ConnectionStats {
    totalConnections: number;
    uniqueUsers: number;
    connectionsByRole: {
        customers: number;
        transporters: number;
        drivers: number;
    };
    roomCount: number;
}
export {};
//# sourceMappingURL=socket.service.d.ts.map